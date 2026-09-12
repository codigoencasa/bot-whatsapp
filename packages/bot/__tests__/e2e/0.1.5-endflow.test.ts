import { suite } from 'uvu'
import * as assert from 'uvu/assert'

import { setup, clear, parseAnswers } from '../../__mock__/env'
import type { MemoryDB } from '../../src'
import { addKeyword, createBot, createFlow, EVENTS } from '../../src'
import type { ProviderMock } from '../../src/provider/providerMock'
import { delay } from '../../src/utils'

const fakeHTTP = async (fakeData: string[] = []) => {
    await delay(50)
    const data = fakeData.map((u) => ({ body: `${u}` }))
    return Promise.resolve(data)
}

const suiteCase = suite<{ provider: ProviderMock; database: MemoryDB }>('Flujo: endFlow')

suiteCase.before.each(setup)
suiteCase.after.each(clear)

suiteCase(`Detener el flujo`, async ({ database, provider }) => {
    const MOCK_VALUES = [
        'Bienvenido te envio muchas marcas',
        'Seleccione marca del auto a cotizar, con el *número* correspondiente',
        'Seleccione la sub marca del auto a cotizar, con el *número* correspondiente:',
        'Los precios rondan:',
    ]
    const flow = addKeyword(['hola'])
        .addAnswer(MOCK_VALUES[0], null, async (_, { flowDynamic }) => {
            const data = await fakeHTTP(['Ford', 'GM', 'BMW'])
            return flowDynamic(data)
        })
        .addAnswer(MOCK_VALUES[1], null, async (_, { endFlow }) => {
            return endFlow()
        })
        .addAnswer(MOCK_VALUES[2])
        .addAnswer(MOCK_VALUES[3], null, async (_, { flowDynamic }) => {
            const data = await fakeHTTP(['1000', '2000', '3000'])
            return flowDynamic(data)
        })

    await createBot({
        database,
        provider,
        flow: createFlow([flow]),
    })

    await provider.delaySendMessage(0, 'message', {
        from: '000',
        body: 'hola',
    })

    await delay(900)
    const history = parseAnswers(database.listHistory).map((item) => item.answer)
    assert.is(MOCK_VALUES[0], history[0])

    //FlowDynamic
    assert.is('Ford', history[1])
    assert.is('GM', history[2])
    assert.is('BMW', history[3])

    assert.is(MOCK_VALUES[1], history[4])

    //FlowDynamic
    assert.is(undefined, history[5])
    assert.is(undefined, history[6])
})

suiteCase(`Detener el flujo flowDynamic`, async ({ database, provider }) => {
    const flow = addKeyword(['hola'])
        .addAnswer('Buenas!', null, async (_, { endFlow, flowDynamic }) => {
            await flowDynamic('Continuamos...')
            return endFlow()
        })
        .addAnswer('Como estas!')

    await createBot({
        database,
        provider,
        flow: createFlow([flow]),
    })

    await provider.delaySendMessage(0, 'message', {
        from: '000',
        body: 'hola',
    })

    await delay(100)
    const history = parseAnswers(database.listHistory).map((item) => item.answer)
    assert.is('Buenas!', history[0])
    assert.is('Continuamos...', history[1])
    assert.is(undefined, history[2])
})

suiteCase(`flowDynamic con capture`, async (context) => {
    const { database, provider } = context
    const MOCK_VALUES = ['¿CUal es tu email?', 'Continuamos....', '¿Cual es tu edad?']

    const flow = addKeyword(['hola'])
        .addAnswer(
            MOCK_VALUES[0],
            {
                capture: true,
            },
            async (ctx, { flowDynamic, fallBack }) => {
                const validation = ctx.body.includes('@')

                if (validation) {
                    const getDataFromApi = await fakeHTTP(['Gracias por tu email se ha validado de manera correcta'])
                    return flowDynamic(getDataFromApi)
                }
                return fallBack()
            }
        )
        .addAnswer(MOCK_VALUES[1])
        .addAnswer(MOCK_VALUES[2], { capture: true }, async (ctx, { flowDynamic, fallBack }) => {
            if (ctx.body !== '18') {
                await delay(20)
                return fallBack('Ups creo que no eres mayor de edad')
            }
            return flowDynamic('Bien tu edad es correcta!')
        })
        .addAnswer('Puedes pasar')

    await createBot({
        database,
        provider,
        flow: createFlow([flow]),
    })

    await provider.delaySendMessage(100, 'message', {
        from: '000',
        body: 'hola',
    })

    await provider.delaySendMessage(150, 'message', {
        from: '000',
        body: 'this is not email value',
    })

    await provider.delaySendMessage(200, 'message', {
        from: '000',
        body: 'test@test.com',
    })

    await provider.delaySendMessage(250, 'message', {
        from: '000',
        body: '20',
    })

    await provider.delaySendMessage(300, 'message', {
        from: '000',
        body: '18',
    })

    await delay(900)
    const history = parseAnswers(database.listHistory).map((item) => item.answer)
    assert.is(MOCK_VALUES[0], history[0])
    assert.is('this is not email value', history[1])
    assert.is(MOCK_VALUES[0], history[2])
    assert.is('test@test.com', history[3])
    assert.is('Gracias por tu email se ha validado de manera correcta', history[4])
    assert.is(MOCK_VALUES[1], history[5])
    assert.is(MOCK_VALUES[2], history[6])
    assert.is('20', history[7])
    assert.is('Ups creo que no eres mayor de edad', history[8])
    assert.is('18', history[9])
    assert.is('Bien tu edad es correcta!', history[10])
    assert.is('Puedes pasar', history[11])
})

suiteCase(`endFlow desde gotoFlow`, async ({ database, provider }) => {
    const flow = addKeyword(['hola'])
        .addAnswer('Buenas!', null, async (_, { gotoFlow }) => {
            return gotoFlow(flowUsuario)
        })
        .addAnswer('no debe llegar')

    const errorFlow = addKeyword(EVENTS.ACTION).addAnswer('error')

    const flowUsuario = addKeyword(EVENTS.ACTION)
        .addAction({ ref: `1111111111111111` }, async (_, { flowDynamic, endFlow, gotoFlow }) => {
            try {
                const confirmar = {
                    data: {
                        estado: '3',
                    },
                } as any
                if (confirmar === 500) {
                    return gotoFlow(errorFlow)
                }
                if (confirmar.data.estado === '3') {
                    return endFlow(`Final y no mas`)
                }

                if (confirmar.data) {
                    await flowDynamic('ya estas! debe finalizar flow no debe enviar mas mensajes')
                    return endFlow()
                }
            } catch (error) {
                console.error(error)
            }
            await flowDynamic('⏳ por favor solo espere a que el asistente responda 🍀🤖...')
        })
        .addAction({ ref: `22222222222` }, async (_, { flowDynamic }) => {
            await flowDynamic('ping pong')
            console.log(`🌟🌟🌟🌟`)
        })

    await createBot({
        database,
        provider,
        flow: createFlow([flow, flowUsuario]),
    })

    await provider.delaySendMessage(100, 'message', {
        from: '000',
        body: 'hola',
    })

    await delay(5000)
    const history = parseAnswers(database.listHistory).map((item) => item.answer)
    assert.is('Buenas!', history[0])
    assert.is('Final y no mas', history[1])
    assert.is(undefined, history[2])
})

suiteCase(`endFlow antes de capture`, async ({ database, provider }) => {
    const flow = addKeyword(['hola'])
        .addAnswer('Buenas!', null, async (_, { gotoFlow }) => {
            return gotoFlow(flowAction)
        })
        .addAnswer('no debe llegar')

    const flowAction = addKeyword(EVENTS.ACTION)
        .addAction(async (_, { flowDynamic, endFlow }) => {
            await flowDynamic('message 1')
            return endFlow(`Finaliza el flow`)
        })
        .addAction({ capture: true }, async (_, { flowDynamic }) => {
            await flowDynamic('no debe llegar')
            console.log(`🌟🌟🌟🌟`)
        })

    await createBot({
        database,
        provider,
        flow: createFlow([flow, flowAction]),
    })

    await provider.delaySendMessage(100, 'message', {
        from: '000',
        body: 'hola',
    })

    await provider.delaySendMessage(150, 'message', {
        from: '000',
        body: 'ping',
    })

    await delay(5000)
    const history = parseAnswers(database.listHistory).map((item) => item.answer)
    assert.is('Buenas!', history[0])
    assert.is('message 1', history[1])
    assert.is('Finaliza el flow', history[2])
    assert.is('ping', history[3])
    assert.is(undefined, history[4])
})

suiteCase(`gotoFlow continue antes de capture`, async ({ database, provider }) => {
    const flow = addKeyword(['paypal'])
        .addAnswer('Buenas!', null, async (_, { gotoFlow }) => {
            return gotoFlow(flowEmail)
        })
        .addAnswer('no debe llegar')

    const flowPay = addKeyword(EVENTS.ACTION).addAnswer('Tu link de pago es http://example.com')

    const flowEmail = addKeyword(EVENTS.ACTION).addAnswer(
        [`¿Cual es tu email?`, `lo necesito para generarte el link de pago y registrarte en la plataforma`],
        { capture: true },
        async (_, { gotoFlow }) => {
            return gotoFlow(flowPay)
        }
    )

    await createBot({
        database,
        provider,
        flow: createFlow([flow, flowEmail, flowPay]),
    })

    await provider.delaySendMessage(100, 'message', {
        from: '000',
        body: 'paypal',
    })

    await provider.delaySendMessage(150, 'message', {
        from: '000',
        body: 'test@test.com',
    })

    await delay(1000)
    const history = parseAnswers(database.listHistory).map((item) => item.answer)
    assert.is('Buenas!', history[0])
    assert.is(
        '¿Cual es tu email?\nlo necesito para generarte el link de pago y registrarte en la plataforma',
        history[1]
    )
    assert.is('test@test.com', history[2])
    assert.is('Tu link de pago es http://example.com', history[3])
    assert.is(undefined, history[4])
})

suiteCase.run()
