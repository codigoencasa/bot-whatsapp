const { EventEmitter } = require('node:events')
const { toCtx } = require('../io/methods')
const { printer } = require('../utils/interactive')
const { delay } = require('../utils/delay')
const { Console } = require('console')
const { createWriteStream } = require('fs')
const Queue = require('../utils/queue')

const { LIST_REGEX } = require('../io/events')
const SingleState = require('../context/state.class')
const GlobalState = require('../context/globalState.class')
const IdleState = require('../context/idleState.class')

const logger = new Console({
    stdout: createWriteStream(`${process.cwd()}/core.class.log`),
})
const loggerQueue = new Console({
    stdout: createWriteStream(`${process.cwd()}/queue.class.log`),
})

const idleForCallback = new IdleState()
const DynamicBlacklist = require('../utils/blacklist.class')

/**
 * [ ] Escuchar eventos del provider asegurarte que los provider emitan eventos
 * [ ] Guardar historial en db
 * [ ] Buscar mensaje en flow
 *
 */
class CoreClass extends EventEmitter {
    flowClass
    databaseClass
    providerClass
    queuePrincipal
    stateHandler = new SingleState()
    globalStateHandler = new GlobalState()
    dynamicBlacklist = new DynamicBlacklist()
    generalArgs = {
        blackList: [],
        listEvents: {},
        delay: 0,
        globalState: {},
        extensions: undefined,
        queue: {
            timeout: 20000,
            concurrencyLimit: 15,
        },
    }
    constructor(_flow, _database, _provider, _args) {
        super()
        this.flowClass = _flow
        this.databaseClass = _database
        this.providerClass = _provider
        this.generalArgs = { ...this.generalArgs, ..._args }
        this.dynamicBlacklist.add(this.generalArgs.blackList)

        this.queuePrincipal = new Queue(
            loggerQueue,
            this.generalArgs.queue.concurrencyLimit,
            this.generalArgs.queue.timeout
        )

        this.globalStateHandler.updateState()(this.generalArgs.globalState)

        if (this.generalArgs.extensions) this.globalStateHandler.RAW = this.generalArgs.extensions

        for (const { event, func } of this.listenerBusEvents()) {
            this.providerClass.on(event, func)
        }
    }

    /**
     * Manejador de eventos
     */
    listenerBusEvents = () => [
        {
            event: 'preinit',
            func: () => printer('Iniciando proveedor, espere...'),
        },
        {
            event: 'require_action',
            func: ({ instructions, title = '⚡⚡ ACCIÓN REQUERIDA ⚡⚡' }) => printer(instructions, title),
        },
        {
            event: 'ready',
            func: () => printer('Proveedor conectado y listo'),
        },
        {
            event: 'auth_failure',
            func: ({ instructions }) => printer(instructions, '⚡⚡ ERROR AUTH ⚡⚡'),
        },
        {
            event: 'message',
            func: (msg) => this.handleMsg(msg),
        },
        {
            event: 'notice',
            func: (note) => printer(note),
        },
    ]

    /**
     * GLOSSARY.md
     * @param {*} messageCtxInComming
     * @returns
     */
    handleMsg = async (messageCtxInComming) => {
        logger.log(`[handleMsg]: `, messageCtxInComming)
        idleForCallback.stop(messageCtxInComming)
        const { body, from } = messageCtxInComming
        let msgToSend = []
        let endFlowFlag = false
        let fallBackFlag = false
        if (this.dynamicBlacklist.checkIf(from)) return
        if (!body) return

        let prevMsg = await this.databaseClass.getPrevByNumber(from)
        const refToContinue = this.flowClass.findBySerialize(prevMsg?.refSerialize)

        if (prevMsg?.ref) {
            delete prevMsg._id
            const ctxByNumber = toCtx({
                body,
                from,
                prevRef: prevMsg.refSerialize,
            })
            await this.databaseClass.save(ctxByNumber)
        }

        // 📄 Mantener estado de conversacion por numero
        const state = {
            getMyState: this.stateHandler.getMyState(messageCtxInComming.from),
            get: this.stateHandler.get(messageCtxInComming.from),
            getAllState: this.stateHandler.getAllState,
            update: this.stateHandler.updateState(messageCtxInComming),
            clear: this.stateHandler.clear(messageCtxInComming.from),
        }

        // 📄 Mantener estado global
        const globalState = {
            getMyState: this.globalStateHandler.getMyState(),
            get: this.globalStateHandler.get(),
            getAllState: this.globalStateHandler.getAllState,
            update: this.globalStateHandler.updateState(messageCtxInComming),
            clear: this.globalStateHandler.clear(),
        }

        const extensions = this.globalStateHandler.RAW

        // 📄 Crar CTX de mensaje (uso private)
        const createCtxMessage = (payload = {}, index = 0) => {
            const body = typeof payload === 'string' ? payload : payload?.body ?? payload?.answer
            const media = payload?.media ?? null
            const buttons = payload?.buttons ?? []
            const capture = payload?.capture ?? false
            const delay = payload?.delay ?? 0
            const keyword = payload?.keyword ?? null

            return toCtx({
                body,
                from,
                keyword,
                index,
                options: { media, buttons, capture, delay },
            })
        }

        // 📄 Limpiar cola de procesos
        const clearQueue = () => {
            this.queuePrincipal.clearQueue(from)
            return
        }

        // 📄 Finalizar flujo
        const endFlow =
            (flag) =>
            async (message = null) => {
                flag.endFlow = true
                endFlowFlag = true
                if (message) this.sendProviderAndSave(from, createCtxMessage(message))
                clearQueue()
                return
            }

        // 📄 Finalizar flujo (patch)
        const endFlowToGotoFlow =
            (flag) =>
            async (messages = null, options = { fromGotoFlow: false, end: false }) => {
                flag.endFlow = true
                endFlowFlag = true

                if (Array.isArray(messages)) {
                    for (const iteratorCtxMessage of messages) {
                        const scopeCtx = await resolveCbEveryCtx(iteratorCtxMessage, {
                            omitEndFlow: options.fromGotoFlow,
                            idleCtx: !!iteratorCtxMessage?.options?.idle,
                            triggerKey: iteratorCtxMessage.keyword.startsWith('key_'),
                        })
                        if (scopeCtx?.endFlow) break
                    }
                }
                clearQueue()
                return
            }

        // 📄 Esta funcion se encarga de enviar un array de mensajes dentro de este ctx
        const sendFlow = async (messageToSend, numberOrId, options = {}) => {
            options = { prev: prevMsg, forceQueue: false, ...options }

            const idleCtxQueue = idleForCallback.get({ from, inRef: prevMsg?.ref })

            const { ref: prevRef, options: prevOptions } = options.prev || {}
            const { capture, idle } = prevOptions || {}

            if (messageCtxInComming?.ref && idleCtxQueue && messageToSend.length) {
                return
            }

            if (capture && idle && messageToSend.length === 0) {
                await cbEveryCtx(prevRef)
                return
            }

            if (capture && !idle) {
                await cbEveryCtx(prevRef)
            }

            for (const ctxMessage of messageToSend) {
                if (endFlowFlag) {
                    break
                }

                const delayMs = ctxMessage?.options?.delay ?? this.generalArgs.delay ?? 0
                await delay(delayMs)

                //TODO el proceso de forzar cola de procsos
                if (options.forceQueue) {
                    await handleForceQueue(ctxMessage, messageToSend, numberOrId, from)
                }

                await enqueueMsg(numberOrId, ctxMessage, from)
            }
        }

        // Se han extraído algunas funcionalidades en nuevas funciones para mejorar la legibilidad
        const handleForceQueue = async (_, messageToSend, numberOrId, from) => {
            const listIdsRefCallbacks = messageToSend.map((i) => i.ref)
            const listProcessWait = this.queuePrincipal.getIdsCallback(from)

            if (!listProcessWait.length) {
                this.queuePrincipal.setIdsCallbacks(from, listIdsRefCallbacks)
            } else {
                const lastMessage = messageToSend[messageToSend.length - 1]
                await this.databaseClass.save({ ...lastMessage, from: numberOrId })

                if (listProcessWait.includes(lastMessage.ref)) {
                    this.queuePrincipal.clearQueue(from)
                }
            }
        }

        const enqueueMsg = async (numberOrId, ctxMessage, from) => {
            try {
                await this.queuePrincipal.enqueue(
                    from,
                    async () => {
                        await this.sendProviderAndSave(numberOrId, ctxMessage)
                            .then(() => resolveCbEveryCtx(ctxMessage))
                            .catch((error) => {
                                logger.error(`Error en sendProviderAndSave (ID ${ctxMessage.ref}):`, error)
                                throw error
                            })

                        logger.log(`[QUEUE_SE_ENVIO]: `, ctxMessage)
                    },
                    ctxMessage.ref
                )
            } catch (error) {
                logger.error(`Error al encolar (ID ${ctxMessage.ref}):`, error)
                throw error
            }
        }

        const continueFlow = async (initRef = undefined) => {
            const currentPrev = await this.databaseClass.getPrevByNumber(from)

            let nextFlow = this.flowClass.find(refToContinue?.ref, true) || []
            if (initRef && !initRef?.idleFallBack) {
                nextFlow = this.flowClass.find(initRef?.ref, true) || []
            }

            const getContinueIndex = nextFlow.findIndex((msg) => msg.refSerialize === currentPrev?.refSerialize)
            const indexToContinue = getContinueIndex !== -1 ? getContinueIndex : 0
            const filterNextFlow = nextFlow
                .slice(indexToContinue)
                .filter((i) => i.refSerialize !== currentPrev?.refSerialize)

            // const filterNextFlow = nextFlow.filter((msg) => msg.refSerialize !== currentPrev?.refSerialize);
            const isContinueFlow = filterNextFlow.map((i) => i.keyword).includes(currentPrev?.ref)

            if (!isContinueFlow) {
                const refToContinueChild = this.flowClass.getRefToContinueChild(currentPrev?.keyword)
                const flowStandaloneChild = this.flowClass.getFlowsChild()
                const nextChildMessages =
                    (await this.flowClass.find(refToContinueChild?.ref, true, flowStandaloneChild)) || []
                if (nextChildMessages?.length)
                    return exportFunctionsSend(() => sendFlow(nextChildMessages, from, { prev: undefined }))

                return exportFunctionsSend(() => sendFlow(filterNextFlow, from, { prev: undefined }))
            }

            if (initRef && !initRef?.idleFallBack) {
                return exportFunctionsSend(() => sendFlow(filterNextFlow, from, { prev: undefined }))
            }
        }
        // 📄 [options: fallBack]: esta funcion se encarga de repetir el ultimo mensaje
        const fallBack =
            (flag) =>
            async (message = null) => {
                this.queuePrincipal.clearQueue(from)
                flag.fallBack = true
                await this.sendProviderAndSave(from, {
                    ...prevMsg,
                    answer: typeof message === 'string' ? message : message?.body ?? prevMsg.answer,
                    options: {
                        ...prevMsg.options,
                        buttons: prevMsg.options?.buttons,
                    },
                })
                return
            }

        const gotoFlow =
            (flag) =>
            async (flowInstance, step = 0) => {
                const promises = []
                flag.gotoFlow = true

                if (!flowInstance?.toJson) {
                    printer([
                        `[POSSIBLE_CIRCULAR_DEPENDENCY]: Se ha detectado una dependencia circular.`,
                        `Para evitar problemas, te recomendamos utilizar 'require'('./ruta_del_flow')`,
                        `Ejemplo:  gotoFlow(helloFlow) -->  gotoFlow(require('./flows/helloFlow.js'))`,
                        `[INFO]: https://bot-whatsapp.netlify.app/docs/goto-flow/`,
                    ])
                    return
                }

                await delay(flowInstance?.ctx?.options?.delay ?? 0)

                const flowTree = flowInstance.toJson()

                const flowParentId = flowTree[step]

                const parseListMsg = await this.flowClass.find(flowParentId?.ref, true, flowTree)

                for (const msg of parseListMsg) {
                    const msgParse = this.flowClass.findSerializeByRef(msg?.ref)

                    const ctxMessage = { ...msgParse, ...msg }
                    await this.sendProviderAndSave(from, ctxMessage).then(() => promises.push(ctxMessage))
                }

                await endFlowToGotoFlow(flag)(promises, { fromGotoFlow: true, ...{ end: endFlowFlag } })
                return
            }

        // 📄 [options: flowDynamic]: esta funcion se encarga de responder un array de respuesta esta limitado a 5 mensajes
        // para evitar bloque de whatsapp

        const flowDynamic =
            (flag, inRef, privateOptions) =>
            async (listMsg = [], options = { continue: true }) => {
                if (!options.hasOwnProperty('continue')) {
                    options = { ...options, continue: true }
                }

                flag.flowDynamic = true

                if (!Array.isArray(listMsg)) {
                    listMsg = [{ body: listMsg, ...options }]
                }

                const parseListMsg = listMsg.map((opt, index) => createCtxMessage(opt, index))

                // Si endFlowFlag existe y no se omite la finalización del flujo, no hacer nada.
                if (endFlowFlag && !privateOptions?.omitEndFlow) {
                    return
                }

                this.queuePrincipal.setFingerTime(from, inRef) // Debe decirle al sistema que finalizó el flujo aquí.

                for (const msg of parseListMsg) {
                    if (privateOptions?.idleCtx) {
                        continue // Saltar al siguiente mensaje si se está en modo idleCtx.
                    }

                    const delayMs = msg?.options?.delay ?? this.generalArgs.delay ?? 0
                    await delay(delayMs)
                    await this.sendProviderAndSave(from, msg)
                }

                if (options?.continue) {
                    await continueFlow()
                    return
                }
                return
            }

        // 📄 Se encarga de revisar si el contexto del mensaje tiene callback o idle
        const resolveCbEveryCtx = async (
            ctxMessage,
            options = { omitEndFlow: false, idleCtx: false, triggerKey: false }
        ) => {
            if (!!ctxMessage?.options?.idle && !ctxMessage?.options?.capture) {
                printer(
                    `[ATENCION IDLE]: La función "idle" no tendrá efecto a menos que habilites la opción "capture:true". Por favor, asegúrate de configurar "capture:true" o elimina la función "idle"`
                )
                return
            }

            // const endFlowState = state.getMyState() && state.get('__end_flow__')
            // if(endFlowState) return

            if (ctxMessage?.options?.idle) {
                const run = await cbEveryCtx(ctxMessage?.ref, { ...options, startIdleMs: ctxMessage?.options?.idle })
                return run
            }
            if (!ctxMessage?.options?.capture) {
                const run = await cbEveryCtx(ctxMessage?.ref, options)
                return run
            }
        }

        // 📄 Se encarga de revisar si el contexto del mensaje tiene callback y ejecutarlo
        const cbEveryCtx = async (
            inRef,
            options = { startIdleMs: 0, omitEndFlow: false, idleCtx: false, triggerKey: false }
        ) => {
            const flags = {
                endFlow: false,
                fallBack: false,
                flowDynamic: false,
                gotoFlow: false,
            }

            const provider = this.providerClass
            const database = this.databaseClass

            if (!this.flowClass.allCallbacks[inRef]) return Promise.resolve()
            const argsCb = {
                database,
                provider,
                state,
                globalState,
                extensions,
                queue: this.queuePrincipal,
                idle: idleForCallback,
                inRef,
                fallBack: fallBack(flags),
                flowDynamic: flowDynamic(flags, inRef, options),
                endFlow: endFlow(flags, inRef),
                gotoFlow: gotoFlow(flags),
            }

            const runContext = async (continueAfterIdle = false, overCtx = {}) => {
                messageCtxInComming = { ...messageCtxInComming, ...overCtx }

                if (options?.idleCtx && !options?.triggerKey) {
                    return
                }

                await this.flowClass.allCallbacks[inRef](messageCtxInComming, argsCb)
                //Si no hay llamado de fallaback y no hay llamado de flowDynamic y no hay llamado de enflow EL flujo continua
                if (continueAfterIdle) {
                    await continueFlow(overCtx)
                    return
                }
                const ifContinue = !flags.endFlow && !flags.fallBack && !flags.flowDynamic
                if (ifContinue) {
                    await continueFlow()
                    return
                }
            }

            if (options.startIdleMs > 0) {
                idleForCallback.setIdleTime({
                    from,
                    inRef,
                    timeInSeconds: options.startIdleMs / 1000,
                    cb: async (opts) => {
                        if (opts?.next) {
                            await runContext(true, { idleFallBack: opts.next, ref: opts.inRef, body: opts.body })
                        }
                    },
                })
                return
            }

            await runContext()
            return { ...flags }
        }

        const exportFunctionsSend = async (cb = () => Promise.resolve()) => {
            await cb()
            return {
                createCtxMessage,
                clearQueue,
                endFlow,
                sendFlow,
                continueFlow,
                fallBack,
                gotoFlow,
                flowDynamic,
                resolveCbEveryCtx,
                cbEveryCtx,
            }
        }

        // 📄🤘(tiene return) [options: nested(array)]: Si se tiene flujos hijos los implementa
        if (!endFlowFlag && prevMsg?.options?.nested?.length) {
            const nestedRef = prevMsg.options.nested
            const flowStandalone = nestedRef.map((f) => ({
                ...nestedRef.find((r) => r.refSerialize === f.refSerialize),
            }))

            msgToSend = this.flowClass.find(body, false, flowStandalone) || []

            return exportFunctionsSend(() => sendFlow(msgToSend, from))
        }

        // 📄🤘(tiene return) Si el mensaje previo implementa capture
        if (!endFlowFlag && !prevMsg?.options?.nested?.length) {
            const typeCapture = typeof prevMsg?.options?.capture

            if (typeCapture === 'boolean' && fallBackFlag) {
                msgToSend = this.flowClass.find(refToContinue?.ref, true) || []
                return exportFunctionsSend(() => sendFlow(msgToSend, from, { forceQueue: true }))
            }
        }

        msgToSend = this.flowClass.find(body) || []

        if (msgToSend.length) {
            return exportFunctionsSend(() => sendFlow(msgToSend, from))
        }

        if (!prevMsg?.options?.capture) {
            msgToSend = this.flowClass.find(this.generalArgs.listEvents.WELCOME) || []

            if (LIST_REGEX.REGEX_EVENT_LOCATION.test(body)) {
                msgToSend = this.flowClass.find(this.generalArgs.listEvents.LOCATION) || []
            }

            if (LIST_REGEX.REGEX_EVENT_MEDIA.test(body)) {
                msgToSend = this.flowClass.find(this.generalArgs.listEvents.MEDIA) || []
            }

            if (LIST_REGEX.REGEX_EVENT_DOCUMENT.test(body)) {
                msgToSend = this.flowClass.find(this.generalArgs.listEvents.DOCUMENT) || []
            }

            if (LIST_REGEX.REGEX_EVENT_VOICE_NOTE.test(body)) {
                msgToSend = this.flowClass.find(this.generalArgs.listEvents.VOICE_NOTE) || []
            }

            if (LIST_REGEX.REGEX_EVENT_ORDER.test(body)) {
                msgToSend = this.flowClass.find(this.generalArgs.listEvents.ORDER) || []
            }

            if (LIST_REGEX.REGEX_EVENT_TEMPLATE.test(body)) {
                msgToSend = this.flowClass.find(this.generalArgs.listEvents.TEMPLATE) || []
            }

            //todo agregar evento para detectar un vcard
            if (LIST_REGEX.REGEX_EVENT_CONTACT.test(body)) {
                msgToSend = this.flowClass.find(this.generalArgs.listEvents.CONTACT) || []
            }
        }

        return exportFunctionsSend(() => sendFlow(msgToSend, from, { forceQueue: true }))
    }

    /**
     * Enviar mensaje con contexto atraves del proveedor de whatsapp
     * @param {*} numberOrId
     * @param {*} ctxMessage ver más en GLOSSARY.md
     * @returns
     */
    sendProviderAndSave = async (numberOrId, ctxMessage) => {
        try {
            const { answer } = ctxMessage
            if (answer && answer.length && answer !== '__call_action__' && answer !== '__goto_flow__') {
                if (answer !== '__capture_only_intended__') {
                    await this.providerClass.sendMessage(numberOrId, answer, ctxMessage)
                    this.emit('send_message', { numberOrId, answer, ctxMessage })
                }
            }
            await this.databaseClass.save({ ...ctxMessage, from: numberOrId })

            return Promise.resolve()
        } catch (err) {
            logger.log(`[ERROR ID (${ctxMessage.ref})]: `, err)
            return Promise.reject()
        }
    }

    /**
     * @deprecated
     * @private
     * @param {*} message
     * @param {*} ref
     */
    continue = (message, ref = false) => {
        const responde = this.flowClass.find(message, ref)
        if (responde) {
            this.providerClass.sendMessage(responde.answer)
            this.databaseClass.saveLog(responde.answer)
            this.continue(null, responde.ref)
        }
    }

    /**
     * Funcion dedicada a enviar el mensaje sin pasar por el flow
     * (dialogflow)
     * @param {*} messageToSend
     * @param {*} numberOrId
     * @returns
     */
    sendFlowSimple = async (messageToSend, numberOrId) => {
        for (const ctxMessage of messageToSend) {
            const delayMs = ctxMessage?.options?.delay ?? this.generalArgs.delay ?? 0
            await delay(delayMs)
            await this.queuePrincipal.enqueue(
                numberOrId,
                () => this.sendProviderAndSave(numberOrId, ctxMessage),
                ctxMessage.ref
            )
            // await queuePromises.dequeue()
        }
        return Promise.resolve
    }
}
module.exports = CoreClass
