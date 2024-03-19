const { ProviderClass } = require('@bot-whatsapp/bot')
const axios = require('axios')
const FormData = require('form-data')
const { createReadStream } = require('fs')
const mime = require('mime-types')
const { generalDownload } = require('../../common/download')
const { convertAudio } = require('../utils/convertAudio')
const MetaWebHookServer = require('./server')
const URL = `https://graph.facebook.com`
const Queue = require('queue-promise')
const path = require('path')

/**
 * ⚙️MetaProvider: Es un provedor que te ofrece enviar
 * mensaje a Whatsapp via API
 * info: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *
 *
 * Necesitas las siguientes tokens y valores
 * { jwtToken, numberId, vendorNumber, verifyToken }
 */
const PORT = process.env.PORT || 3000

class MetaProvider extends ProviderClass {
    metHook = undefined
    jwtToken = undefined
    numberId = undefined
    version = 'v16.0'

    constructor({ jwtToken, numberId, verifyToken, version, port = PORT }) {
        super()
        this.jwtToken = jwtToken
        this.numberId = numberId
        this.version = version
        this.metHook = new MetaWebHookServer(jwtToken, numberId, version, verifyToken, port)
        this.metHook.start()

        const listEvents = this.busEvents()

        for (const { event, func } of listEvents) {
            this.metHook.on(event, func)
        }

        this.queue = new Queue({
            concurrent: 1, // Cantidad de tareas que se ejecutarán en paralelo
            interval: 100, // Intervalo entre tareas
            start: true, // Iniciar la cola automáticamente
        })
    }

    /**
     * Mapeamos los eventos nativos a los que la clase Provider espera
     * para tener un standar de eventos
     * @returns
     */
    busEvents = () => [
        {
            event: 'auth_failure',
            func: (payload) => this.emit('error', payload),
        },
        {
            event: 'ready',
            func: () => this.emit('ready', true),
        },
        {
            event: 'message',
            func: (payload) => {
                this.emit('message', payload)
            },
        },
    ]

    /**
     * Sends a message with metadata to the API.
     *
     * @param {Object} body - The body of the message.
     * @return {Promise} A Promise that resolves when the message is sent.
     */
    sendMessageMeta(body) {
        return this.queue.add(() => this.sendMessageToApi(body))
    }

    /**
     * Sends a message to the API.
     *
     * @param {Object} body - The body of the message.
     * @return {Object} The response data from the API.
     */
    async sendMessageToApi(body) {
        try {
            const response = await axios.post(`${URL}/${this.version}/${this.numberId}/messages`, body, {
                headers: {
                    Authorization: `Bearer ${this.jwtToken}`,
                },
            })
            return response.data
        } catch (error) {
            console.error(error)
            throw error
        }
    }

    sendtext = async (number, message) => {
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'text',
            text: {
                preview_url: false,
                body: message,
            },
        }
        return this.sendMessageMeta(body)
    }

    sendImage = async (number, mediaInput = null) => {
        if (!mediaInput) throw new Error(`MEDIA_INPUT_NULL_: ${mediaInput}`)

        const formData = new FormData()
        const mimeType = mime.lookup(mediaInput)
        formData.append('file', createReadStream(mediaInput), {
            contentType: mimeType,
        })
        formData.append('messaging_product', 'whatsapp')

        const {
            data: { id: mediaId },
        } = await axios.post(`${URL}/${this.version}/${this.numberId}/media`, formData, {
            headers: {
                Authorization: `Bearer ${this.jwtToken}`,
                ...formData.getHeaders(),
            },
        })

        const body = {
            messaging_product: 'whatsapp',
            to: number,
            type: 'image',
            image: {
                id: mediaId,
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     *
     * @param {*} number
     * @param {*} _
     * @param {*} pathVideo
     * @returns
     */
    sendVideo = async (number, pathVideo = null) => {
        if (!pathVideo) throw new Error(`MEDIA_INPUT_NULL_: ${pathVideo}`)

        const formData = new FormData()
        const mimeType = mime.lookup(pathVideo)
        formData.append('file', createReadStream(pathVideo), {
            contentType: mimeType,
        })
        formData.append('messaging_product', 'whatsapp')

        const {
            data: { id: mediaId },
        } = await axios.post(`${URL}/${this.version}/${this.numberId}/media`, formData, {
            headers: {
                Authorization: `Bearer ${this.jwtToken}`,
                ...formData.getHeaders(),
            },
        })

        const body = {
            messaging_product: 'whatsapp',
            to: number,
            type: 'video',
            video: {
                id: mediaId,
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     *
     * @param {*} number
     * @param {*} _
     * @param {*} pathDocument
     * @returns
     */
    sendFile = async (number, pathFile = null) => {
        if (!pathFile) throw new Error(`MEDIA_INPUT_NULL_: ${pathFile}`)

        const formData = new FormData()
        const mimeType = mime.lookup(pathFile)
        formData.append('file', createReadStream(pathFile), {
            contentType: mimeType,
        })
        formData.append('messaging_product', 'whatsapp')

        const nameOriginal = path.basename(pathFile) || 'Doc'

        const {
            data: { id: mediaId },
        } = await axios.post(`${URL}/${this.version}/${this.numberId}/media`, formData, {
            headers: {
                Authorization: `Bearer ${this.jwtToken}`,
                ...formData.getHeaders(),
            },
        })

        const body = {
            messaging_product: 'whatsapp',
            to: number,
            type: 'document',
            document: {
                id: mediaId,
                filename: nameOriginal,
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * @alpha
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'https://dominio.com/imagen.jpg' | 'img/imagen.jpg')
     */

    sendMedia = async (number, text = '', mediaInput) => {
        const fileDownloaded = await generalDownload(mediaInput)
        const mimeType = mime.lookup(fileDownloaded)
        mediaInput = fileDownloaded
        if (mimeType.includes('image')) return this.sendImage(number, mediaInput)
        if (mimeType.includes('video')) return this.sendVideo(number, fileDownloaded)
        if (mimeType.includes('audio')) {
            const fileOpus = await convertAudio(mediaInput)
            return this.sendAudio(number, fileOpus, text)
        }

        return this.sendFile(number, mediaInput)
    }

    /**
     * Enviar listas
     * @param {*} number
     * @param {*} text
     * @param {*} buttons
     * @returns
     */
    sendLists = async (number, list) => {
        const parseList = { ...list, ...{ type: 'list' } }
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'interactive',
            interactive: parseList,
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Enviar listas alternativo
     * @param {*} number
     * @param {*} header
     * @param {*} text
     * @param {*} footer
     * @param {*} button
     * @param {*} list
     * @returns
     */
    sendList = async (number, header, text, footer, button, list) => {
        const parseList = list.map((list) => ({
            title: list.title,
            rows: list.rows.map((row) => ({
                id: row.id,
                title: row.title,
                description: row.description,
            })),
        }))

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'interactive',
            interactive: {
                type: 'list',
                header: {
                    type: 'text',
                    text: header,
                },
                body: {
                    text: text,
                },
                footer: {
                    text: footer,
                },
                action: {
                    button: button,
                    sections: parseList,
                },
            },
        }
        return this.sendMessageMeta(body)
    }
    /**
     * Enviar buttons
     * @param {*} number
     * @param {*} text
     * @param {*} buttons
     * @returns
     */
    sendButtons = async (number, text, buttons) => {
        const parseButtons = buttons.map((btn, i) => ({
            type: 'reply',
            reply: {
                id: `btn-${i}`,
                title: btn.body,
            },
        }))

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text: text,
                },
                action: {
                    buttons: parseButtons,
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Enviar buttons only text
     * @param {*} number
     * @param {*} text
     * @param {*} buttons
     * @returns
     */
    sendButtonsText = async (number, text, buttons) => {
        const parseButtons = buttons.map((btn) => ({
            type: 'reply',
            reply: {
                id: btn.id,
                title: btn.title,
            },
        }))
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text: text,
                },
                action: {
                    buttons: parseButtons,
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Enviar buttons with image
     * @param {*} number
     * @param {*} text
     * @param {*} buttons
     * @param {*} url
     * @returns
     */
    sendButtonsMedia = async (number, text, buttons, url) => {
        const parseButtons = buttons.map((btn) => ({
            type: 'reply',
            reply: {
                id: btn.id,
                title: btn.title,
            },
        }))
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'interactive',
            interactive: {
                type: 'button',
                header: {
                    type: 'image',
                    image: {
                        link: url,
                    },
                },
                body: {
                    text: text,
                },
                action: {
                    buttons: parseButtons,
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Enviar plantillas
     * @param {*} number
     * @param {*} template
     * @param {*} languageCode
     * Usarse de acuerdo a cada plantilla en particular, esto solo es un mapeo de como funciona.
     * @returns
     */

    sendTemplate = async (number, template, languageCode) => {
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'template',
            template: {
                name: template,
                language: {
                    code: languageCode, // examples: es_Mex, en_Us
                },
                components: [
                    {
                        type: 'header',
                        parameters: [
                            {
                                type: 'image',
                                image: {
                                    link: 'https://i.imgur.com/3xUQq0U.png',
                                },
                            },
                        ],
                    },
                    {
                        type: 'body',
                        parameters: [
                            {
                                type: 'text', // currency, date_time, etc
                                text: 'text-string',
                            },
                            {
                                type: 'currency',
                                currency: {
                                    fallback_value: '$100.99',
                                    code: 'USD',
                                    amount_1000: 100990,
                                },
                            },
                        ],
                    },
                    {
                        type: 'button',
                        subtype: 'quick_reply',
                        index: 0,
                        parameters: [
                            {
                                type: 'payload',
                                payload: 'aGlzIHRoaXMgaXMgY29v',
                            },
                        ],
                    },
                ],
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Enviar Contactos
     * @param {*} number
     * @param {*} contact
     * @returns
     */

    sendContacts = async (number, contact) => {
        const parseContacts = contact.map((contact) => ({
            name: {
                formatted_name: contact.name,
                first_name: contact.first_name,
                last_name: contact.last_name,
                middle_name: contact.middle_name,
                suffix: contact.suffix,
                prefix: contact.prefix,
            },
            birthday: contact.birthday,
            phones: contact.phones.map((phone) => ({
                phone: phone.phone,
                wa_id: phone.wa_id,
                type: phone.type,
            })),
            emails: contact.emails.map((email) => ({
                email: email.email,
                type: email.type,
            })),
            org: {
                company: contact.company,
                department: contact.department,
                title: contact.title,
            },
            urls: contact.urls.map((url) => ({
                url: url.url,
                type: url.type,
            })),
            addresses: contact.addresses.map((address) => ({
                street: address.street,
                city: address.city,
                state: address.state,
                zip: address.zip,
                country: address.country,
                country_code: address.counry_code,
                type: address.type,
            })),
        }))

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'contacts',
            contacts: parseContacts,
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Enviar catálogo
     * @param {*} number
     * @param {*} bodyText
     * @param {*} itemCatalogId
     * @param {*} footerText
     * @returns
     */

    sendCatalog = async (number, bodyText, itemCatalogId) => {
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'interactive',
            interactive: {
                type: 'catalog_message',
                body: {
                    text: bodyText,
                },
                action: {
                    name: 'catalog_message',
                    parameters: {
                        thumbnail_product_retailer_id: itemCatalogId,
                    },
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     *
     * @param {*} userId
     * @param {*} message
     * @param {*} param2
     * @returns
     */
    sendMessage = async (number, message, { options }) => {
        if (options?.buttons?.length) return this.sendButtons(number, message, options.buttons)
        if (options?.media) return this.sendMedia(number, message, options.media)

        this.sendtext(number, message)
    }

    /**
     * Enviar reacción a un mensaje
     * @param {*} number
     * @param {*} react
     */
    sendReaction = async (number, react) => {
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: number,
            type: 'reaction',
            reaction: {
                message_id: react.message_id,
                emoji: react.emoji,
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Enviar Ubicación
     * @param {*} longitude
     * @param {*} latitude
     * @param {*} name
     * @param {*} address
     * @returns
     */
    sendLocation = async (number, localization) => {
        const body = {
            messaging_product: 'whatsapp',
            to: number,
            type: 'location',
            location: {
                longitude: localization.long_number,
                latitude: localization.lat_number,
                name: localization.name,
                address: localization.address,
            },
        }
        return this.sendMessageMeta(body)
    }
}

module.exports = MetaProvider
