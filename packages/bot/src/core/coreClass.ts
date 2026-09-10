import { Console } from 'console'
import { createWriteStream } from 'fs'

import type {
    BotCtxMethods,
    BotStateGlobal,
    BotStateStandAlone,
    DispatchFn,
    DynamicBlacklist,
    FlagsRuntime,
    ProviderEventTypes,
    TContext,
} from './../types'
import type { HostEventTypes } from './eventEmitterClass'
import { EventEmitterClass } from './eventEmitterClass'
import { GlobalState, IdleState, SingleState } from '../context'
import type { MemoryDB } from '../db'
import { LIST_REGEX } from '../io/events'
import type FlowClass from '../io/flowClass'
import { toCtx } from '../io/methods'
import type { ProviderClass } from '../provider/interface/provider'
import type { FlowDynamicMessage, GeneralArgs, MessageContextIncoming } from '../types'
import { BlackList, Queue } from '../utils'
import { delay } from '../utils/delay'
import { printer } from '../utils/interactive'

const logger = new Console({
    stdout: createWriteStream(`${process.cwd()}/core.class.log`),
})
const loggerQueue = new Console({
    stdout: createWriteStream(`${process.cwd()}/queue.class.log`),
})

const idleForCallback = new IdleState()

class CoreClass<P extends ProviderClass = any, D extends MemoryDB = any> extends EventEmitterClass<HostEventTypes> {
    flowClass: FlowClass
    database: D
    provider: P
    queuePrincipal: Queue<unknown>
    stateHandler = new SingleState()
    globalStateHandler = new GlobalState()
    dynamicBlacklist = new BlackList()
    generalArgs: GeneralArgs & { host?: string } & { globalArg?: boolean } = {
        blackList: [],
        listEvents: {},
        delay: 0,
        logs: {
            notices: true,
        },
        globalState: {},
        extensions: undefined,
        queue: {
            timeout: 20000,
            concurrencyLimit: 15,
        },
        host: undefined,
    }

    /**
     * @description
     * - Setup flowClass
     * - Setup database
     * - Setup provider
     * - Setup generalArgs
     */
    constructor(_flow: any, _database: D, _provider: P, _args: GeneralArgs | null | undefined) {
        super()
        this.flowClass = _flow
        this.database = _database
        this.provider = _provider
        const args = _args ?? {}
        this.generalArgs = {
            ...this.generalArgs,
            ...args,
            logs: {
                ...this.generalArgs.logs,
                ...(args.logs ?? {}),
            },
        }

        this.dynamicBlacklist.add(this.generalArgs.blackList)

        this.queuePrincipal = new Queue(
            loggerQueue,
            this.generalArgs.queue.concurrencyLimit ?? 15,
            this.generalArgs.queue.timeout
        )

        this.globalStateHandler.updateState()(this.generalArgs.globalState)

        if (this.generalArgs.extensions) this.globalStateHandler.RAW = this.generalArgs.extensions

        for (const { event, func } of this.listenerBusEvents()) {
            this.provider.on(event, func)
        }
    }

    /**
     * Event handler
     */
    listenerBusEvents = (): {
        event: string
        func: ProviderEventTypes[keyof ProviderEventTypes]
    }[] => [
        {
            event: 'require_action',
            func: ({ instructions, title = '' }) => printer(instructions, title),
        },
        {
            event: 'notice',
            func: ({ instructions, title = '' }) => {
                if (this.generalArgs.logs?.notices === false) return
                printer(instructions, title, 'bgMagenta')
            },
        },
        {
            event: 'ready',
            func: () =>
                printer(['Tell a contact on your WhatsApp to write "hello"...'], '✅ Connected Provider', 'bgCyan'),
        },
        {
            event: 'auth_failure',
            func: ({ instructions }) => printer(instructions, '⚡⚡ ERROR AUTH ⚡⚡'),
        },
        {
            event: 'message',
            func: (msg: MessageContextIncoming) => {
                const fromNum = msg.from ? msg.from.replace('@c.us', '').replace('+', '').replace(/\s/g, '') : ''
                const hostNum = this.generalArgs.host
                    ? this.generalArgs.host.replace('@c.us', '').replace('+', '').replace(/\s/g, '')
                    : ''
                if (this.generalArgs.globalArg === false && fromNum === hostNum) {
                    return
                }
                return this.handleMsg({ ...msg, host: `${this.generalArgs?.host}` })
            },
        },
        {
            event: 'host',
            func: (payload: { phone: string }) => this.setHostData(payload),
        },
    ]

    private setHostData = (hostNumber: { phone: string }) => {
        this.generalArgs.host = hostNumber.phone
    }

    handleMsg = async (messageCtxInComing: MessageContextIncoming) => {
        logger.log(`[handleMsg]: `, messageCtxInComing)
        idleForCallback.stop(messageCtxInComing)
        const { body, from } = messageCtxInComing
        let msgToSend = []
        let endFlowFlag = this.stateHandler.get(from)('__end_flow__') || false
        const fallBackFlag = false

        if (this.dynamicBlacklist.checkIf(from)) return
        if (!body) return

        const prevMsg = await this.database.getPrevByNumber(from)
        const refToContinue = this.flowClass.findBySerialize(prevMsg?.refSerialize)

        if (prevMsg?.ref) {
            delete prevMsg._id
            const ctxByNumber = toCtx({
                body,
                from,
                prevRef: prevMsg.refSerialize,
            })
            await this.database.save(ctxByNumber)
        }

        // 📄 Mantener estado de conversacion por numero
        const state = {
            getMyState: this.stateHandler.getMyState(messageCtxInComing.from),
            get: this.stateHandler.get(messageCtxInComing.from),
            update: this.stateHandler.updateState(messageCtxInComing),
            clear: this.stateHandler.clear(messageCtxInComing.from),
        }

        // 📄 Mantener estado global
        const globalState = {
            get: this.globalStateHandler.get(),
            getAllState: this.globalStateHandler.getAllState,
            update: this.globalStateHandler.updateState(),
            clear: this.globalStateHandler.clear(),
        }

        const extensions = this.globalStateHandler.RAW

        // 📄 Crar CTX de mensaje (uso private)
        const createCtxMessage = (
            payload: {
                body: any
                answer: any
                media: string
                buttons: any[]
                capture: boolean
                delay: number
                keyword: null
            },
            index = 0
        ) => {
            const body = typeof payload === 'string' ? payload : (payload?.body ?? payload?.answer)
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
            (flag: FlagsRuntime, inRef: string | number) =>
            async (message = null) => {
                flag.endFlow = true
                endFlowFlag = true
                if (message) {
                    this.sendProviderAndSave(from, createCtxMessage(message)).then(() =>
                        this.sendProviderAndSave(
                            from,
                            createCtxMessage({ ...message, keyword: `${inRef}`, answer: '__end_flow__' })
                        )
                    )
                } else {
                    this.sendProviderAndSave(
                        from,
                        createCtxMessage({ ...message, keyword: `${inRef}`, answer: '__end_flow__' })
                    )
                }
                clearQueue()
                return
            }

        // 📄 Finalizar flujo (patch)
        const endFlowToGotoFlow =
            (flag: FlagsRuntime) =>
            async (messages: TContext[] = []) => {
                flag.endFlow = true
                endFlowFlag = true

                for (const iteratorCtxMessage of messages) {
                    const keyWord = Array.isArray(iteratorCtxMessage.keyword)
                        ? iteratorCtxMessage.keyword.join(' ')
                        : iteratorCtxMessage.keyword
                    const scopeCtx = await resolveCbEveryCtx(iteratorCtxMessage, {
                        omitEndFlow: true,
                        idleCtx: !!iteratorCtxMessage?.options?.idle,
                        triggerKey: keyWord.startsWith('key_'),
                    })
                    if (scopeCtx?.endFlow) break
                }

                clearQueue()
                return
            }

        // 📄 Esta funcion se encarga de enviar un array de mensajes dentro de este ctx
        const sendFlow = async (messageToSend: any[], numberOrId: string, options: { [key: string]: any } = {}) => {
            options = { prev: prevMsg, forceQueue: false, ...options }

            const idleCtxQueue = idleForCallback.get({ from, inRef: prevMsg?.ref })

            const { ref: prevRef, options: prevOptions } = options.prev || {}
            const { capture, idle } = prevOptions || {}

            if (messageCtxInComing?.ref && idleCtxQueue && messageToSend.length) {
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

                if (options.forceQueue) {
                    await handleForceQueue(ctxMessage, messageToSend, numberOrId, from)
                }

                await enqueueMsg(numberOrId, ctxMessage, from)
            }
        }

        // Se han extraído algunas funcionalidades en nuevas funciones para mejorar la legibilidad
        const handleForceQueue = async (_: any, messageToSend: any[], numberOrId: string, from: string) => {
            const listIdsRefCallbacks = messageToSend.map((i: { ref: string }) => i.ref)
            const listProcessWait = this.queuePrincipal.getIdsCallback(from)

            // Registrar/actualizar el conjunto de IDs que están en curso para este "from"
            if (!listProcessWait.length) {
                this.queuePrincipal.setIdsCallbacks(from, listIdsRefCallbacks)
                return
            }

            // Si ya hay una lista en proceso, actualizamos la referencia
            this.queuePrincipal.setIdsCallbacks(from, listIdsRefCallbacks)

            // Guardamos el último mensaje como hacía la implementación previa para conservar historial
            const lastMessage = messageToSend[messageToSend.length - 1]
            await this.database.save({ ...lastMessage, from: numberOrId })

            // Evitamos limpiar agresivamente toda la cola; los duplicados se gestionan en la propia cola
            return
        }

        const enqueueMsg = async (numberOrId: string, ctxMessage: TContext, from: string) => {
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

        const continueFlow = async (initRef = undefined): Promise<any> => {
            try {
                const currentPrev = await this.database.getPrevByNumber(from)
                if (!currentPrev?.keyword) return
                let nextFlow = this.flowClass.find(refToContinue?.ref, true) || []
                if (initRef && !initRef?.idleFallBack) {
                    nextFlow = this.flowClass.find(initRef?.ref, true) || []
                }

                const getContinueIndex = nextFlow.findIndex((msg) => msg.refSerialize === currentPrev?.refSerialize)
                const indexToContinue = getContinueIndex !== -1 ? getContinueIndex : 0
                const filterNextFlow = nextFlow
                    .slice(indexToContinue)
                    .filter((i) => i.refSerialize !== currentPrev?.refSerialize)

                const isContinueFlow = filterNextFlow.map((i) => i.keyword).includes(currentPrev?.ref)

                if (!isContinueFlow) {
                    const refToContinueChild = this.flowClass.getRefToContinueChild(currentPrev?.keyword)
                    const flowStandaloneChild = this.flowClass.getFlowsChild()
                    const nextChildMessages =
                        this.flowClass.find(refToContinueChild?.ref, true, flowStandaloneChild) || []

                    if (nextChildMessages.length) {
                        return exportFunctionsSend(() => sendFlow(nextChildMessages, from, { prev: undefined }))
                    }

                    return exportFunctionsSend(() => sendFlow(filterNextFlow, from, { prev: undefined }))
                }

                if (initRef && !initRef?.idleFallBack) {
                    return exportFunctionsSend(() => sendFlow(filterNextFlow, from, { prev: undefined }))
                }
            } catch (error) {
                // Manejar errores aquí según tu lógica de manejo de errores.
                console.error('Error en continueFlow:', error)
            }
        }
        // 📄 [options: fallBack]: esta funcion se encarga de repetir el ultimo mensaje
        const fallBack =
            (flag: FlagsRuntime) =>
            async (message = null) => {
                this.queuePrincipal.clearQueue(from)
                flag.fallBack = true
                await this.sendProviderAndSave(from, {
                    ...prevMsg,
                    answer: typeof message === 'string' ? message : (message?.body ?? prevMsg.answer),
                    options: {
                        ...prevMsg.options,
                        buttons: prevMsg.options?.buttons,
                    },
                })
                return
            }

        const gotoFlow =
            (flag: FlagsRuntime) =>
            async (flowInstance: { toJson: () => any; ctx: { options: { delay: any } } }, step = 0) => {
                idleForCallback.stop({ from })
                const promises: TContext[] = []
                flag.gotoFlow = true

                if (!flowInstance?.toJson) {
                    printer(
                        [
                            `Circular dependency detected.`,
                            `To avoid issues, we recommend using 'require'('./flow_path')`,
                            `Example:  gotoFlow(helloFlow) -->  gotoFlow(require('./flows/helloFlow.js'))`,
                            `https://bot-whatsapp.netlify.app/docs/goto-flow/`,
                        ],
                        `POSSIBLE_CIRCULAR_DEPENDENCY`
                    )
                    return
                }

                await delay(flowInstance?.ctx?.options?.delay ?? 0)

                const flowTree = flowInstance.toJson()

                const flowParentId = flowTree[step]

                const parseListMsg = this.flowClass.find(flowParentId?.ref, true, flowTree)

                for (const msg of parseListMsg) {
                    const msgParse = this.flowClass.findSerializeByRef(msg?.ref)

                    const ctxMessage: TContext = { ...msgParse, ...msg }
                    await this.sendProviderAndSave(from, ctxMessage).then(() => promises.push(ctxMessage))
                }

                await endFlowToGotoFlow(flag)(promises)
                return
            }

        // 📄 [options: flowDynamic]: esta funcion se encarga de responder un array de respuesta esta limitado a 5 mensajes
        // para evitar bloque de whatsapp

        const flowDynamic =
            (
                flag: FlagsRuntime,
                inRef: string,
                privateOptions: { [x: string]: any; omitEndFlow?: boolean; idleCtx?: boolean }
            ) =>
            async (listMessages: string | string[] | FlowDynamicMessage[] = [], options = { continue: true }) => {
                if (!options.hasOwnProperty('continue')) {
                    options = { ...options, continue: true }
                }

                flag.flowDynamic = true

                if (!Array.isArray(listMessages)) {
                    listMessages = [{ body: listMessages, ...options }]
                }

                const parseListMsg = listMessages.map((opt: string | FlowDynamicMessage, index: number) => {
                    const optParse: {
                        body: any
                        answer: any
                        media: string
                        buttons: any[]
                        capture: boolean
                        delay: number
                        keyword: null
                    } = {
                        capture: false,
                        body: '',
                        buttons: [],
                        media: null,
                        delay: this.generalArgs.delay ?? 0,
                        keyword: null,
                        answer: undefined,
                    }

                    if (typeof opt === 'string') {
                        optParse.body = opt
                    } else {
                        optParse.body = opt?.body ?? ' '
                        optParse.media = opt?.media ?? null
                        optParse.buttons = opt?.buttons ?? []
                        optParse.delay = opt?.delay ?? this.generalArgs.delay ?? 0
                    }

                    return createCtxMessage(optParse, index)
                })

                // Si endFlowFlag existe y no se omite la finalización del flujo, no hacer nada.
                if (endFlowFlag && !privateOptions?.omitEndFlow) {
                    return
                }

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
            ctxMessage: TContext,
            options = { omitEndFlow: false, idleCtx: false, triggerKey: false }
        ) => {
            if (!!ctxMessage?.options?.idle && !ctxMessage?.options?.capture) {
                printer(
                    [
                        `The "idle" function will have no effect unless you enable the "capture:true" option.`,
                        `Please make sure to configure "capture:true" or remove the "idle" function`,
                    ],
                    `IDLE ATTENTION`
                )
                return
            }

            if (ctxMessage?.options?.idle) {
                const run = await cbEveryCtx(ctxMessage?.ref, { ...options, startIdleMs: ctxMessage?.options?.idle })
                return run as unknown as TContext
            }
            if (!ctxMessage?.options?.capture) {
                const run = await cbEveryCtx(ctxMessage?.ref, options)
                return run as unknown as TContext
            }
        }

        // 📄 Se encarga de revisar si el contexto del mensaje tiene callback y ejecutarlo
        const cbEveryCtx = async (
            inRef: string,
            options: { [key: string]: any } = { startIdleMs: 0, omitEndFlow: false, idleCtx: false, triggerKey: false }
        ) => {
            const flags: FlagsRuntime = {
                endFlow: false,
                fallBack: false,
                flowDynamic: false,
                gotoFlow: false,
            }

            const provider = this.provider
            const database = this.database

            if (!this.flowClass.allCallbacks[inRef]) return Promise.resolve()

            /** argumentos que se exponen */
            const argsCb = {
                database,
                provider,
                flows: this.flowClass.flowRaw,
                state,
                globalState,
                extensions,
                blacklist: this.dynamicBlacklist,
                queue: this.queuePrincipal,
                idle: idleForCallback,
                inRef,
                fallBack: fallBack(flags),
                flowDynamic: flowDynamic(flags, inRef, options),
                endFlow: endFlow(flags, inRef),
                gotoFlow: gotoFlow(flags),
            }

            const runContext = async (continueAfterIdle = false, overCtx: any = {}) => {
                try {
                    messageCtxInComing = { ...messageCtxInComing, ...overCtx }

                    if (options?.idleCtx && !options?.triggerKey) {
                        return
                    }

                    await this.flowClass.allCallbacks[inRef](messageCtxInComing, argsCb)
                    //Si no hay llamado de fallaback y no hay llamado de flowDynamic y no hay llamado de enflow EL flujo continua
                    if (continueAfterIdle) {
                        idleForCallback.stop({ from })
                        await continueFlow(overCtx)
                        return
                    }
                    const ifContinue = !flags.endFlow && !flags.fallBack && !flags.flowDynamic
                    if (ifContinue) {
                        idleForCallback.stop({ from })
                        await continueFlow()
                        return
                    }
                } catch (error) {
                    return Promise.reject(error)
                }
            }

            if (options.startIdleMs > 0) {
                idleForCallback.setIdleTime({
                    from,
                    inRef,
                    timeInSeconds: options.startIdleMs / 1000,
                    cb: async (opts: any) => {
                        if (opts.next) {
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
            const flowStandalone = nestedRef.map((f: { refSerialize: string }) => ({
                ...nestedRef.find((r: { refSerialize: string }) => r.refSerialize === f.refSerialize),
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

            if (LIST_REGEX.REGEX_EVENT_CALL.test(body)) {
                msgToSend = this.flowClass.find(this.generalArgs.listEvents.CALL) || []
            }
        }

        await this.stateHandler.updateState({ from })({ __end_flow__: false })
        return exportFunctionsSend(() => sendFlow(msgToSend, from, { forceQueue: true }))
    }

    /**
     * Enviar mensaje con contexto atraves del proveedor de whatsapp
     * @param {*} numberOrId
     * @param {*} ctxMessage ver más en GLOSSARY.md
     * @returns
     */
    sendProviderAndSave = async (numberOrId: string, ctxMessage: TContext) => {
        try {
            const { answer } = ctxMessage
            if (
                answer &&
                answer.length &&
                answer !== '__call_action__' &&
                answer !== '__goto_flow__' &&
                answer !== '__end_flow__'
            ) {
                if (answer !== '__capture_only_intended__') {
                    const respMessage = await this.provider.sendMessage(numberOrId, answer, ctxMessage)
                    this.emit('send_message', {
                        ...ctxMessage,
                        from: numberOrId,
                        answer: answer,
                        respMessage: respMessage,
                    } as TContext & { from: string; answer: string | string[]; respMessage: any })
                }
            }
            await this.database.save({ ...ctxMessage, from: numberOrId })

            return Promise.resolve()
        } catch (err) {
            logger.log(`[ERROR ID (${ctxMessage.ref})]: `, err)
            return Promise.reject(err)
        }
    }

    /**
     * Funcion dedicada a enviar el mensaje sin pasar por el flow
     * (dialogflow)
     * @param {*} messageToSend
     * @param {*} numberOrId
     * @returns
     */
    sendFlowSimple = async (messageToSend: any, numberOrId: any) => {
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

    /**
     *
     */
    httpServer = (port: number) => {
        this.provider.initAll(port, {
            blacklist: this.dynamicBlacklist,
            state: (number: string): BotStateStandAlone => ({
                getMyState: this.stateHandler.getMyState(number),
                get: this.stateHandler.get(number),
                update: this.stateHandler.updateState({ from: number }),
                clear: this.stateHandler.clear(number),
            }),
            emit: (eventName: 'send_message' | 'notice', args: Record<string, any> & { from: string }) => {
                if (eventName === 'send_message') {
                    this.emit('send_message', {
                        ...args,
                        from: args.from,
                        answer: args.answer || '',
                        respMessage: args.respMessage || null,
                    } as TContext & { from: string; answer: string | string[]; respMessage: any })
                } else if (eventName === 'notice') {
                    this.emit('notice', {
                        title: args.title || '',
                        instructions: args.instructions || [],
                    })
                }
            },
            globalState: (): BotStateGlobal => ({
                get: this.globalStateHandler.get(),
                getAllState: this.globalStateHandler.getAllState,
                update: this.globalStateHandler.updateState(),
                clear: this.globalStateHandler.clear(),
            }),
            ctxMethods: this.buildCtxMethods(),
        })
    }

    /**
     * Build context methods for HTTP handlers
     * @returns {BotCtxMethods}
     */
    private buildCtxMethods = (): BotCtxMethods => ({
        endFlow: async (from: string) => {
            this.queuePrincipal.clearQueue(from)
            this.stateHandler.updateState({ from })({ __end_flow__: true })
        },
    })

    /**
     *
     * @param ctxPolka
     * @returns
     */
    handleCtx = (
        ctxPolka: (
            bot:
                | (Pick<P, 'sendMessage' | 'vendor'> & {
                      provider: P
                      blacklist: DynamicBlacklist
                      dispatch: DispatchFn
                      state: (number: string) => BotStateStandAlone
                      globalState: () => BotStateGlobal
                      ctxMethods: BotCtxMethods
                      emit: (eventName: string, args: Record<string, any> & { from: string }) => void
                  })
                | undefined,
            req: any,
            res: any
        ) => Promise<void>
    ) => {
        try {
            return this.provider.inHandleCtx(ctxPolka)
        } catch (e) {
            console.error('[handleCtx error]', e)
            return Promise.resolve()
        }
    }
}
export { CoreClass }
