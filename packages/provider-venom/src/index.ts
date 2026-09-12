import { ProviderClass, utils } from '@builderbot/bot'
import type { Vendor } from '@builderbot/bot/dist/provider/interface/provider'
import type { BotContext, Button, GlobalVendorArgs, SendOptions } from '@builderbot/bot/dist/types'
import { createReadStream, existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import mime from 'mime-types'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import type polka from 'polka'
import venom from 'venom-bot'

import type { SaveFileOptions } from './types'
import { venomCleanNumber, venomDeleteTokens, venomGenerateImage, venomisValidNumber } from './utils'

/**
 * ⚙️ VenomProvider: Es una clase tipo adaptor
 * que extiende clases de ProviderClass (la cual es como interfaz para sber que funciones rqueridas)
 * https://github.com/orkestral/venom
 */
class VenomProvider extends ProviderClass {
    globalVendorArgs: GlobalVendorArgs = {
        name: 'bot',
        gifPlayback: false,
        port: 3000,
        writeMyself: 'none',
    }
    vendor: venom.Whatsapp
    constructor(args: { name: string; gifPlayback: boolean }) {
        super()
        this.globalVendorArgs = { ...this.globalVendorArgs, ...args }
    }

    private generateFileName = (extension: string): string => `file-${Date.now()}.${extension}`

    protected async initVendor(): Promise<any> {
        const NAME_DIR_SESSION = `${this.globalVendorArgs.name}_sessions`
        try {
            const client = await venom.create(
                NAME_DIR_SESSION,
                (base) => this.generateQr(base),
                (info) => {
                    console.log({ info })
                    if (
                        [
                            'initBrowser',
                            'openBrowser',
                            'initWhatsapp',
                            'successPageWhatsapp',
                            'notLogged',
                            'waitForLogin',
                            'waitChat',
                            'successChat',
                        ].includes(info)
                    ) {
                        console.clear()
                        this.emit('notice', {
                            title: '⏱️  Loading... ',
                            instructions: [`this process can take up to 90 seconds`, `we will let you know shortly`],
                        })
                    }
                },
                {
                    updatesLog: false,
                    disableSpins: true,
                    disableWelcome: true,
                    logQR: false,
                    autoClose: 45000,
                    headless: 'new',
                    ...this.globalVendorArgs,
                    folderNameToken: NAME_DIR_SESSION,
                }
            )

            this.vendor = client
            const hostDevice: any = await this.vendor.getHostDevice()
            const { id, pushname } = hostDevice
            const host = {
                name: pushname,
                phone: id.user,
            }

            client.onIncomingCall(async (call) => {
                console.log(call)
                // client.sendText(call.peerJid, "Sorry, I still can't answer calls");
            })
            this.emit('ready', true)
            this.emit('host', host)
            return client
        } catch (e) {
            console.log(e)
            this.emit('auth_failure', {
                instructions: [`An error occurred during Venom initialization`, `trying again in 5 seconds...`],
            })
            venomDeleteTokens(NAME_DIR_SESSION)
            setTimeout(async () => {
                console.clear()
                await this.initVendor()
            }, 5000)
        }
    }

    protected listenOnEvents(vendor: Vendor<venom.Whatsapp>): void {
        if (!vendor) {
            throw new Error(`Vendor should not return empty`)
        }

        if (!this.vendor) {
            this.vendor = vendor
        }

        const listEvents = this.busEvents()
        for (const { event, func } of listEvents) {
            if (this.vendor[event])
                this.vendor[event]((payload: venom.Message & { lat?: string; lng?: string; name: string }) =>
                    func(payload)
                )
        }
    }

    protected beforeHttpServerInit(): void {
        this.server = this.server
            .use((req, _, next) => {
                req['globalVendorArgs'] = this.globalVendorArgs
                return next()
            })
            .get('/', this.indexHome)
    }

    /**
     *
     * @param req
     * @param res
     */
    public indexHome: polka.Middleware = (req, res) => {
        const botName = req[this.idBotName]
        const qrPath = join(process.cwd(), `${botName}.qr.png`)

        if (!existsSync(qrPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ error: 'QR code not generated yet' }))
        }

        const fileStream = createReadStream(qrPath)
        res.writeHead(200, { 'Content-Type': 'image/png' })
        fileStream.pipe(res)
    }

    protected afterHttpServerInit(): void {}

    /**
     * Generamos QR Code pra escanear con el Whatsapp
     */
    generateQr = async (qr: string) => {
        console.clear()

        this.emit('notice', {
            title: '🛜  HTTP Server ON ',
            instructions: this.getListRoutes(this.server),
        })

        this.emit('require_action', {
            title: '⚡⚡ ACTION REQUIRED ⚡⚡',
            instructions: [
                `You must scan the QR Code`,
                `Remember that the QR code updates every minute`,
                `Need help: https://link.codigoencasa.com/DISCORD`,
            ],
            payload: { qr },
        })

        await venomGenerateImage(qr, `${this.globalVendorArgs.name}.qr.png`)
    }

    /**
     * Mapeamos los eventos nativos de  https://docs.orkestral.io/venom/#/?id=events
     * para tener un standar de eventos
     * @returns
     */
    busEvents = () => [
        {
            event: 'onMessage',
            func: (payload: venom.Message & { lat?: string; lng?: string; name: string }) => {
                if (payload.from === 'status@broadcast') {
                    return
                }
                if (!venomisValidNumber(payload.from)) {
                    return
                }

                payload.from = venomCleanNumber(payload.from, true)
                payload.name = `${payload.sender?.pushname}`

                if (payload.hasOwnProperty('type') && ['image', 'video'].includes(payload.type)) {
                    payload = {
                        ...payload,
                        body: utils.generateRefProvider('_event_media_'),
                    }
                }

                if (payload.hasOwnProperty('type') && ['document'].includes(payload.type)) {
                    payload = { ...payload, body: utils.generateRefProvider('_event_document_') }
                }

                if (payload.hasOwnProperty('type') && ['ptt'].includes(payload.type)) {
                    payload = { ...payload, body: utils.generateRefProvider('_event_voice_note_') }
                }
                if (payload.hasOwnProperty('lat') && payload.hasOwnProperty('lng')) {
                    const lat = payload.lat
                    const lng = payload.lng
                    if (lat !== '' && lng !== '') {
                        payload = { ...payload, body: utils.generateRefProvider('_event_location_') }
                    }
                }
                this.emit('message', payload)
            },
        },
    ]

    /**
     * @deprecated Buttons are not available in this provider, please use sendButtons instead
     * @private
     * @param {*} number
     * @param {*} message
     * @param {*} buttons []
     * @returns
     */
    sendButtons = async (number: string, message: string, buttons: Button[] = []) => {
        this.emit('notice', {
            title: 'DEPRECATED',
            instructions: [
                `Currently sending buttons is not available with this provider`,
                `this function is available with Meta or Twilio`,
            ],
        })
        const buttonToStr = [message].concat(buttons.map((btn) => `${btn.body}`)).join(`\n`)
        return this.vendor.sendText(number, buttonToStr)
        // return this.vendor.sendButtons(number, "Title", buttons1, "Description");
    }

    /**
     * Enviar audio
     * @alpha
     * @param {string} number
     * @param {string} message
     * @param {boolean} voiceNote optional
     * @example await sendMessage('+XXXXXXXXXXX', 'audio.mp3')
     */

    sendAudio = async (number: string, audioPath: string) => {
        return this.vendor.sendVoice(number, audioPath)
    }

    /**
     * Enviar imagen
     * @param {*} number
     * @param {*} imageUrl
     * @param {*} text
     * @returns
     */
    sendImage = async (number: string, filePath: string, text: string) => {
        const fileName = basename(filePath)
        return this.vendor.sendImage(number, filePath, fileName, text)
    }

    /**
     *
     * @param {string} number
     * @param {string} filePath
     * @example await sendMessage('+XXXXXXXXXXX', './document/file.pdf')
     */

    sendFile = async (number: string, filePath: string, text: string) => {
        const fileName = basename(filePath)
        return this.vendor.sendFile(number, filePath, fileName, text)
    }

    /**
     * Enviar video
     * @param {*} number
     * @param {*} imageUrl
     * @param {*} text
     * @returns
     */
    sendVideo = async (number: string, filePath: string, text: string) => {
        return this.vendor.sendVideoAsGif(number, filePath, 'video.gif', text)
    }

    /**
     * Enviar imagen o multimedia
     * @param {*} number
     * @param {*} mediaInput
     * @param {*} message
     * @returns
     */
    sendMedia = async (number: string, mediaUrl: string, text: string) => {
        const fileDownloaded = await utils.generalDownload(mediaUrl)
        const mimeType = mime.lookup(fileDownloaded)
        if (`${mimeType}`.includes('image')) return this.sendImage(number, fileDownloaded, text)
        if (`${mimeType}`.includes('video')) return this.sendVideo(number, fileDownloaded, text)
        if (`${mimeType}`.includes('audio')) {
            const fileOpus = await utils.convertAudio(fileDownloaded, 'mp3')
            return this.sendAudio(number, fileOpus)
        }

        return this.sendFile(number, fileDownloaded, text)
    }

    /**
     *
     * @param number
     * @param message
     * @param options
     * @returns
     */
    sendMessage = async (number: string, message: string, options?: SendOptions): Promise<any> => {
        options = { ...options, ...options['options'] }
        number = venomCleanNumber(number)
        if (options?.buttons?.length) return this.sendButtons(number, message, options.buttons)
        if (options?.media) return this.sendMedia(number, options.media, message)
        return this.vendor.sendText(number, message)
    }

    /**
     *
     * @param ctx
     * @param options
     * @returns
     */
    saveFile = async (ctx: Partial<venom.Message & BotContext>, options: SaveFileOptions = {}): Promise<string> => {
        try {
            const { mimetype } = ctx
            const buffer = await this.vendor.decryptFile(ctx as venom.Message)
            const extension = mime.extension(mimetype) as string
            const fileName = this.generateFileName(extension)
            const pathFile = join(options?.path ?? tmpdir(), fileName)
            await writeFile(pathFile, buffer)
            return resolve(pathFile)
        } catch (err) {
            console.log(`[Error]:`, err.message)
            return 'ERROR'
        }
    }
}

export { VenomProvider }
