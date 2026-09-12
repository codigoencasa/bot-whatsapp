import { ProviderClass, utils } from '@builderbot/bot'
import type { Vendor } from '@builderbot/bot/dist/provider/interface/provider'
import type { BotContext, Button, SendOptions } from '@builderbot/bot/dist/types'
import type { ISttAdapter, ITtsAdapter, MetaCallCoreVendor } from '@builderbot/provider-voice'
import axios from 'axios'
import FormData from 'form-data'
import { createReadStream } from 'fs'
import { writeFile } from 'fs/promises'
import mime from 'mime-types'
import { tmpdir } from 'os'
import { join, basename, resolve } from 'path'
import Queue from 'queue-promise'

import { MetaCoreVendor } from './core'
import { downloadFile, getOrderDetails, getProfile } from '../utils'
import { isBSUID, parseMetaNumber, resolveOutboundAddress } from '../utils/number'

import type { MetaInterface } from '~/interface/meta'
import type {
    MetaGlobalVendorArgs,
    MetaOrderDetails,
    Localization,
    Message,
    MetaList,
    Order,
    ParsedContact,
    Reaction,
    SaveFileOptions,
    TextMessageBody,
} from '~/types'

const URL = `https://graph.facebook.com`
const URL_REGEX = /https?:\/\/[^\s]+/

class MetaProvider extends ProviderClass<MetaInterface> implements MetaInterface {
    public vendor: Vendor<any>
    public queue: Queue = new Queue()
    /** Core vendor for WhatsApp Business voice calls — only set when `enableVoiceCalls` is true. */
    public callVendor?: MetaCallCoreVendor

    public globalVendorArgs: MetaGlobalVendorArgs = {
        name: 'bot',
        jwtToken: '',
        numberId: '',
        verifyToken: '',
        version: 'v18.0',
        port: 3000,
        writeMyself: 'none',
    }
    public prefixMap = {
        '549': '54', // ARG prefix
        '521': '52', // MEX prefix
    }

    constructor(args: MetaGlobalVendorArgs) {
        super()
        this.globalVendorArgs = { ...this.globalVendorArgs, ...args }
        this.queue = new Queue({
            concurrent: 1,
            interval: 100,
            start: true,
        })
    }

    protected beforeHttpServerInit(): void {
        this.server = this.server
            .use((req, _, next) => {
                req['globalVendorArgs'] = this.globalVendorArgs
                return next()
            })
            .post('/', this.vendor.indexHome)
            .get('/webhook', this.vendor.verifyToken)
            .post('/webhook', this.vendor.incomingMsg)
    }

    /**
     * Get the profile of a WhatsApp user
     * @returns The profile of the WhatsApp user
     */

    protected async afterHttpServerInit(): Promise<void> {
        try {
            const { version, numberId, jwtToken } = this.globalVendorArgs
            // Get profile
            const profile = await getProfile(version, numberId, jwtToken)
            const host = {
                ...profile,
                phone: profile?.display_phone_number,
            }
            this.vendor.emit('host', host)
            this.emit('ready')

            this.emit('notice', {
                title: '🔗 WEBHOOK REQUIRED',
                instructions: [
                    'Remember to configure the webhook in your Meta dashboard:',
                    '- Callback URL: https://<your-domain>/webhook',
                    '- Verify with your verifyToken',
                    '- Subscribe to the "messages" field',
                    'https://builderbot.app/en/providers/meta',
                ],
            })
        } catch (err) {
            const errorMap = {
                'Invalid token': { title: '🔑 TOKEN ERROR', msg: 'Check META_ACCESS_TOKEN in .env' },
                timeout: { title: '🌐 TIMEOUT', msg: 'Meta API not responding' },
                '401': { title: '🔐 UNAUTHORIZED', msg: 'Invalid credentials' },
                '403': { title: '🚫 FORBIDDEN', msg: 'Token lacks permissions' },
                '500': { title: '🔧 SERVER ERROR', msg: 'Meta API issues' },
            }

            const errorKey = err.message.includes('Invalid token')
                ? 'Invalid token'
                : err.message.includes('timeout')
                  ? 'timeout'
                  : err.response?.status === 401
                    ? '401'
                    : err.response?.status === 403
                      ? '403'
                      : err.response?.status >= 500
                        ? '500'
                        : 'default'

            const error = errorMap[errorKey] || { title: '🟠 ERROR AUTH', msg: 'Check credentials' }

            this.emit('notice', {
                title: error.title,
                instructions: [error.msg, 'https://builderbot.app/en/providers/meta'],
            })
            this.emit('error', err)
        }
    }

    protected async initVendor(): Promise<any> {
        if (this.globalVendorArgs.enableVoiceCalls) {
            this.callVendor = await this.buildCallVendor()
            this.callVendor.on('message', (payload: BotContext) => this.emit('message', payload))
            this.callVendor.on('notice', (payload: { title: string; instructions: string[] }) =>
                this.emit('notice', payload)
            )
        }

        const vendor = new MetaCoreVendor(this.queue, this.callVendor)
        this.server = this.server
            .use((req, _, next) => {
                req['globalVendorArgs'] = this.globalVendorArgs
                return next()
            })
            .get('/webhook', vendor.verifyToken)
            .post('/webhook', vendor.incomingMsg)

        this.vendor = vendor
        return Promise.resolve(this.vendor)
    }

    /**
     * Build the shared call core vendor for WhatsApp Business voice calls.
     *
     * `@builderbot/provider-voice` (and its native `@roamhq/wrtc` dependency) is
     * imported lazily here — via dynamic `import()` — so it is only loaded into
     * the process when a bot actually opts in with `enableVoiceCalls: true`.
     * Bots that never enable voice calls never touch that module graph, which
     * matters because `@roamhq/wrtc` ships prebuilt native binaries for only a
     * subset of platforms/architectures.
     *
     * Resolves STT/TTS adapters (custom or default OpenAI) and validates that
     * `openaiApiKey` is present unless both adapters are provided.
     *
     * @returns The initialized `MetaCallCoreVendor`.
     * @throws {Error} When `openaiApiKey` is missing and both adapters are not provided.
     */
    private async buildCallVendor(): Promise<MetaCallCoreVendor> {
        const config = this.globalVendorArgs
        const hasOpenAI = Boolean(config.openaiApiKey)
        const hasStt = Boolean(config.sttAdapter)
        const hasTts = Boolean(config.ttsAdapter)

        if (!hasOpenAI && !(hasStt && hasTts)) {
            throw new Error(
                '[MetaProvider] "openaiApiKey" is required when "enableVoiceCalls" is true and custom STT/TTS ' +
                    'adapters are not both provided. Either set openaiApiKey, or provide both sttAdapter and ttsAdapter.'
            )
        }

        const { MetaCallCoreVendor, OpenAISTTAdapter, OpenAITTSAdapter } = await import('@builderbot/provider-voice')

        const sttAdapter: ISttAdapter = config.sttAdapter ?? new OpenAISTTAdapter({ apiKey: config.openaiApiKey })
        const ttsAdapter: ITtsAdapter = config.ttsAdapter ?? new OpenAITTSAdapter({ apiKey: config.openaiApiKey })

        return new MetaCallCoreVendor({
            sttAdapter,
            ttsAdapter,
            config,
        })
    }

    /**
     * Fix phone number prefixes for specific countries (Argentina, Mexico)
     * @param phoneNumber - Phone number to fix
     * @returns Fixed phone number with correct prefix
     */
    protected fixPrefixMetaNumber = (phoneNumber: string) => {
        if (isBSUID(phoneNumber)) return phoneNumber
        for (const [prev, current] of Object.entries(this.prefixMap)) {
            if (phoneNumber.startsWith(prev)) {
                return phoneNumber.replace(prev, current)
            }
        }
        return phoneNumber
    }

    /**
     * Save a file from a message context to the local filesystem
     * @param ctx - Message context containing the file URL
     * @param options - Save options including the destination path
     * @returns Promise with the absolute path of the saved file, or 'ERROR' if failed
     * @example
     * const filePath = await provider.saveFile(ctx, { path: '/tmp/downloads' })
     */
    saveFile = async (ctx: Partial<Message & BotContext>, options: SaveFileOptions = {}): Promise<string> => {
        try {
            if (ctx.audio) {
                // Lazily loaded — see `buildCallVendor` for why `@builderbot/provider-voice`
                // must never be a top-level import in this file.
                const { pcmToWav } = await import('@builderbot/provider-voice')
                const wav = pcmToWav(ctx.audio, ctx.sampleRate ?? 16000)
                const fileName = `voice-call-${ctx.from ?? 'unknown'}-${Date.now()}.wav`
                const pathFile = join(options?.path ?? tmpdir(), fileName)
                await writeFile(pathFile, wav)
                return resolve(pathFile)
            }
            const url = ctx?.url ?? ctx?.fileData?.url
            const { buffer, extension } = await downloadFile(url, this.globalVendorArgs.jwtToken)
            const fileName = `file-${Date.now()}.${extension}`
            const pathFile = join(options?.path ?? tmpdir(), fileName)
            await writeFile(pathFile, buffer)
            return resolve(pathFile)
        } catch (err) {
            console.log(`[Error]:`, err.message)
            return 'ERROR'
        }
    }

    /**
     * Get file buffer from a message context without saving to disk
     * @param ctx - Message context containing the file URL
     * @param options - Optional save options (unused but kept for API consistency)
     * @returns Promise with the file buffer, or empty buffer if failed
     * @example
     * const buffer = await provider.saveBuffer(ctx)
     */
    saveBuffer = async (ctx: Partial<Message & BotContext>, options: SaveFileOptions = {}): Promise<Buffer> => {
        try {
            const url = ctx?.url ?? ctx?.fileData?.url
            const { buffer } = await downloadFile(url, this.globalVendorArgs.jwtToken)
            return buffer
        } catch (err) {
            console.log(`[Error]:`, err.message)
            return Buffer.from('')
        }
    }

    /**
     * Retrieve full order details by querying the Meta Graph API catalog.
     *
     * The WhatsApp order webhook only provides `catalog_id`, `product_retailer_id`,
     * `quantity`, `item_price`, and `currency`. This method enriches that data by
     * calling the catalog API to resolve product names, images, and the catalog title.
     *
     * Requires the access token to have read access to the catalog
     * (`catalog_management` permission or equivalent).
     *
     * @param order - The `order` object from `ctx.order` in an EVENTS.ORDER handler
     * @returns Enriched order details including title, products with name/imageUrl/price, and total
     * @example
     * addKeyword(EVENTS.ORDER).addAction(async (ctx, { provider }) => {
     *     const details = await provider.getOrderDetails(ctx.order)
     *     // details.title
     *     // details.products[].name, .imageUrl, .price, .quantity
     *     // details.price.total, details.price.currency
     *     // orderDate -> new Date(ctx.timestamp * 1000)
     * })
     */
    getOrderDetails = async (order: Order): Promise<MetaOrderDetails> => {
        if (!order || typeof order !== 'object' || !('catalog_id' in order)) {
            console.log('[MetaProvider.getOrderDetails] called without a valid Order object; returning empty result')
            const { version, jwtToken } = this.globalVendorArgs
            return getOrderDetails(version, jwtToken, null)
        }
        const { version, jwtToken } = this.globalVendorArgs
        return getOrderDetails(version, jwtToken, order)
    }

    /**
     * Get the list of event handlers for the provider bus
     * @returns Array of event handlers for auth_failure, notice, ready, message, and host events
     */
    busEvents = () => [
        {
            event: 'auth_failure',
            func: (payload: any) => this.emit('auth_failure', payload),
        },
        {
            event: 'notice',
            func: ({ instructions, title }) => this.emit('notice', { instructions, title }),
        },
        {
            event: 'ready',
            func: () => this.emit('ready', true),
        },
        {
            event: 'message',
            func: (payload: BotContext) => {
                this.emit('message', payload)
            },
        },
        {
            event: 'host',
            func: (payload: any) => {
                this.emit('host', payload)
            },
        },
    ]

    /**
     * Send an image message by uploading a local file
     * @param to - Recipient phone number
     * @param mediaInput - Local path to the image file
     * @param caption - Optional caption for the image
     * @param context - Optional message ID to reply to
     * @returns Promise with the API response
     * @throws Error if mediaInput is null
     * @example
     * await provider.sendImage('1234567890', '/path/to/image.jpg', 'Check this out!')
     */
    sendImage = async (to: string, mediaInput = null, caption: string, context = null) => {
        to = parseMetaNumber(to)
        if (!mediaInput) throw new Error(`MEDIA_INPUT_NULL_: ${mediaInput}`)

        const formData = new FormData()
        const mimeType = mime.lookup(mediaInput)
        formData.append('file', createReadStream(mediaInput), {
            contentType: mimeType,
        })
        formData.append('messaging_product', 'whatsapp')

        const {
            data: { id: mediaId },
        } = await axios.post(
            `${URL}/${this.globalVendorArgs.version}/${this.globalVendorArgs.numberId}/media`,
            formData,
            {
                headers: {
                    Authorization: `Bearer ${this.globalVendorArgs.jwtToken}`,
                    ...formData.getHeaders(),
                },
            }
        )

        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: {
                id: mediaId,
                caption,
            },
        }
        if (context) body.context = { message_id: context }
        return this.sendMessageMeta(body)
    }

    /**
     * Send an image message using a URL
     * @param to - Recipient phone number
     * @param url - Public URL of the image
     * @param caption - Optional caption for the image
     * @param context - Optional message ID to reply to
     * @returns Promise with the API response
     * @example
     * await provider.sendImageUrl('1234567890', 'https://example.com/image.jpg', 'Nice photo!')
     */
    sendImageUrl = async (to: string, url: string, caption = '', context = null) => {
        to = parseMetaNumber(to)
        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'image',
            image: {
                link: url,
                caption,
            },
        }
        if (context) body.context = { message_id: context }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a video message by uploading a local file
     * @param to - Recipient phone number
     * @param pathVideo - Local path to the video file
     * @param caption - Optional caption for the video
     * @param context - Optional message ID to reply to
     * @returns Promise with the API response
     * @throws Error if pathVideo is null
     * @example
     * await provider.sendVideo('1234567890', '/path/to/video.mp4', 'Watch this!')
     */
    sendVideo = async (to: string, pathVideo = null, caption: string, context = null) => {
        to = parseMetaNumber(to)
        if (!pathVideo) throw new Error(`MEDIA_INPUT_NULL_: ${pathVideo}`)

        const formData = new FormData()
        const mimeType = mime.lookup(pathVideo)
        formData.append('file', createReadStream(pathVideo), {
            contentType: mimeType,
        })
        formData.append('messaging_product', 'whatsapp')
        const {
            data: { id: mediaId },
        } = await axios.post(
            `${URL}/${this.globalVendorArgs.version}/${this.globalVendorArgs.numberId}/media`,
            formData,
            {
                headers: {
                    Authorization: `Bearer ${this.globalVendorArgs.jwtToken}`,
                    ...formData.getHeaders(),
                },
            }
        )

        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            to,
            type: 'video',
            video: {
                id: mediaId,
                caption,
            },
        }
        if (context) body.context = { message_id: context }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a video message using a URL
     * @param to - Recipient phone number
     * @param url - Public URL of the video
     * @param caption - Optional caption for the video
     * @param context - Optional message ID to reply to
     * @returns Promise with the API response
     * @example
     * await provider.sendVideoUrl('1234567890', 'https://example.com/video.mp4', 'Check this video!')
     */
    sendVideoUrl = async (to: string, url: string, caption = '', context = null) => {
        to = parseMetaNumber(to)
        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'video',
            video: {
                link: url,
                caption,
            },
        }
        if (context) body.context = { message_id: context }
        return this.sendMessageMeta(body)
    }

    /**
     * Send media message (auto-detects type: image, video, audio, or document)
     * @param to - Recipient phone number
     * @param text - Caption or text for the media
     * @param mediaInput - URL or path to the media file
     * @param context - Optional message ID to reply to
     * @returns Promise with the API response
     * @example
     * // Automatically detects and sends as appropriate type
     * await provider.sendMedia('1234567890', 'Here is the file', 'https://example.com/file.pdf')
     */
    sendMedia = async (to: string, text = '', mediaInput: string, context = null) => {
        to = parseMetaNumber(to)
        const fileDownloaded = await utils.generalDownload(mediaInput)
        const mimeType = mime.lookup(fileDownloaded)
        mediaInput = fileDownloaded
        if (mimeType.includes('image')) return this.sendImage(to, mediaInput, text, context)
        if (mimeType.includes('video')) return this.sendVideo(to, fileDownloaded, text, context)
        if (mimeType.includes('audio')) {
            // sendAudio handles conversion to OGG/Opus automatically
            return this.sendAudio(to, mediaInput, context)
        }

        return this.sendFile(to, mediaInput, text, context)
    }

    /**
     * Send an interactive list message
     * @param to - Recipient phone number
     * @param list - List configuration object with header, body, footer, and action sections
     * @returns Promise with the API response
     * @example
     * await provider.sendList('1234567890', {
     *   header: { type: 'text', text: 'Menu' },
     *   body: { text: 'Select an option' },
     *   footer: { text: 'Powered by Bot' },
     *   action: { button: 'View', sections: [...] }
     * })
     */
    sendList = async (to: string, list: MetaList) => {
        to = parseMetaNumber(to)
        const parseList = { ...list, ...{ type: 'list' } }
        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: parseList,
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a complete interactive list message with all components
     * @param to - Recipient phone number
     * @param header - Header text for the list
     * @param text - Body text for the list
     * @param footer - Footer text for the list
     * @param button - Button text to open the list
     * @param list - Array of sections with rows
     * @returns Promise with the API response
     * @example
     * await provider.sendListComplete('1234567890', 'Menu', 'Choose an option', 'Footer', 'View Options', [
     *   { title: 'Section 1', rows: [{ id: '1', title: 'Option 1', description: 'Description' }] }
     * ])
     */
    sendListComplete = async (
        to: string,
        header: string,
        text: string,
        footer: string,
        button: string,
        list: Record<string, any>
    ) => {
        to = parseMetaNumber(to)
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
            to,
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
     * Send an interactive message with reply buttons
     * @param to - Recipient phone number
     * @param buttons - Array of button objects (max 3 buttons, 20 chars each)
     * @param text - Body text for the message
     * @returns Promise with the API response
     * @example
     * await provider.sendButtons('1234567890', [
     *   { body: 'Yes' },
     *   { body: 'No' },
     *   { body: 'Maybe' }
     * ], 'Do you agree?')
     */
    sendButtons = async (to: string, buttons: Button[] = [], text: string) => {
        to = parseMetaNumber(to)
        const parseButtons = buttons.map((btn, i) => ({
            type: 'reply',
            reply: {
                id: `btn-${i}`,
                title: btn.body.slice(0, 16),
            },
        }))

        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text,
                },
                action: {
                    buttons: parseButtons,
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a call-to-action URL button
     * @param to - Recipient phone number
     * @param button - Button object with body text and URL
     * @param text - Body text for the message
     * @returns Promise with the API response
     * @example
     * await provider.sendButtonUrl('1234567890', { body: 'Visit Site', url: 'https://example.com' }, 'Click below')
     */
    sendButtonUrl = async (to: string, button: Button & { url: string }, text: string): Promise<any> => {
        to = parseMetaNumber(to)
        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                body: {
                    text,
                },
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: button.body.slice(0, 16),
                        url: button.url,
                    },
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send an interactive message with media header and reply buttons
     * @param to - Recipient phone number
     * @param media_type - Type of media: 'image' or 'video'
     * @param buttons - Array of button objects (max 3 buttons)
     * @param text - Body text for the message
     * @param url - Public URL of the media file
     * @returns Promise with the API response
     * @example
     * await provider.sendButtonsMedia('1234567890', 'image', [{ body: 'Buy' }], 'Product info', 'https://example.com/product.jpg')
     */
    sendButtonsMedia = async (to: string, media_type: string, buttons = [], text: string, url: string) => {
        to = parseMetaNumber(to)
        const parseButtons = buttons.map((btn, i) => ({
            type: 'reply',
            reply: {
                id: `btn-${i}`,
                title: btn.body.slice(0, 16),
            },
        }))
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                header: {
                    type: media_type,
                    [media_type === 'video' ? 'video' : 'image']: {
                        link: url,
                    },
                },
                body: {
                    text,
                },
                action: {
                    buttons: parseButtons,
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a pre-approved template message
     * @param to - Recipient phone number
     * @param template - Template name as registered in Meta Business
     * @param languageCode - Language code (e.g., 'en_US', 'es_MX')
     * @param components - Optional array of template components (header, body, buttons)
     * @returns Promise with the API response
     * @example
     * await provider.sendTemplate('1234567890', 'hello_world', 'en_US', [
     *   { type: 'body', parameters: [{ type: 'text', text: 'John' }] }
     * ])
     */
    sendTemplate = async (to: string, template: string, languageCode: string, components = []) => {
        to = parseMetaNumber(to)
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'template',
            template: {
                name: template,
                language: {
                    code: languageCode, // ---> examples: es_Mx, en_Us
                },
                components: components.length > 0 ? components : [],
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a WhatsApp Flow message
     * @param to - Recipient phone number
     * @param headerText - Header text for the flow message
     * @param bodyText - Body text for the flow message
     * @param footerText - Footer text for the flow message
     * @param flowMessageVer - Flow message version (default: '3')
     * @param flowAction - Flow action type (default: 'navigate')
     * @param flowID - Flow ID from Meta Business
     * @param flowToken - Flow token for authentication
     * @param flowCta - Call-to-action button text
     * @param isDraftFlow - Whether the flow is in draft mode
     * @param screenName - Initial screen name to display
     * @param data - Custom data to pass to the flow
     * @returns Promise with the API response
     * @example
     * await provider.sendFlow('1234567890', 'Survey', 'Complete our survey', 'Thanks!', '3', 'navigate', 'flow123', 'token', 'Start', false, 'WELCOME', {})
     */
    sendFlow = async (
        to: string,
        headerText: string,
        bodyText: string,
        footerText: string,
        flowMessageVer: string,
        flowAction: string,
        flowID: string,
        flowToken: string,
        flowCta: string,
        isDraftFlow: boolean,
        screenName: string,
        data: Record<string, any>
    ) => {
        to = parseMetaNumber(to)
        const body = {
            messaging_product: 'whatsapp',
            to,
            recipient_type: 'individual',
            type: 'interactive',
            interactive: {
                type: 'flow',
                header: {
                    type: 'text',
                    text: headerText,
                },
                body: {
                    text: bodyText,
                },
                footer: {
                    text: footerText,
                },
                action: {
                    name: 'flow',
                    parameters: {
                        flow_message_version: flowMessageVer ?? '3',
                        flow_action: flowAction ?? 'navigate',
                        flow_token: flowToken ?? '<FLOW_TOKEN>',
                        flow_id: flowID,
                        flow_cta: flowCta,
                        flow_action_payload: {
                            screen: screenName,
                            data: data ? data : { '<CUSTOM_KEY>': '<CUSTOM_VALUE>' },
                        },
                        ...(isDraftFlow && { mode: 'draft' }),
                    },
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send contact cards to a recipient
     * @param to - Recipient phone number
     * @param contacts - Array of parsed contact objects
     * @returns Promise with the API response
     * @example
     * await provider.sendContacts('1234567890', [{
     *   name: { formatted_name: 'John Doe', first_name: 'John' },
     *   phones: [{ phone: '+1234567890', type: 'MOBILE' }]
     * }])
     */
    sendContacts = async (to: string, contacts: ParsedContact[] = []) => {
        to = parseMetaNumber(to)

        const body = {
            messaging_product: 'whatsapp',
            to,
            type: 'contacts',
            contacts,
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a product catalog message
     * @param to - Recipient phone number
     * @param text - Body text for the catalog message
     * @param itemCatalogId - Product retailer ID to show as thumbnail
     * @returns Promise with the API response
     * @example
     * await provider.sendCatalog('1234567890', 'Check out our products!', 'product123')
     */
    sendCatalog = async (to: string, text: string, itemCatalogId: string) => {
        to = parseMetaNumber(to)
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'catalog_message',
                body: {
                    text,
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
     * Send a message with automatic type detection (text, buttons, or media)
     * @param to - Recipient phone number
     * @param message - Message text content
     * @param options - Optional send options (buttons, media, preview_url)
     * @param options.preview_url - Whether to show URL previews. Auto-detected when omitted (true if message contains a URL).
     * @param context - Optional message ID to reply to
     * @returns Promise with the API response
     * @example
     * // Send text
     * await provider.sendMessage('1234567890', 'Hello!')
     *
     * // Send with buttons
     * await provider.sendMessage('1234567890', 'Choose:', { buttons: [{ body: 'Option 1' }] })
     *
     * // Send with media
     * await provider.sendMessage('1234567890', 'Check this:', { media: 'https://example.com/image.jpg' })
     *
     * // Send with link preview enabled
     * await provider.sendMessage('1234567890', 'Visit https://example.com', { preview_url: true })
     *
     * // Send with link preview disabled
     * await provider.sendMessage('1234567890', 'Visit https://example.com', { preview_url: false })
     */
    sendMessage = async (to: string, message: string, options?: SendOptions, context?: string): Promise<any> => {
        to = parseMetaNumber(to)
        if (this.callVendor?.hasActiveCall(to)) return this.callVendor.publishAudio(to, message)
        options = { ...options, ...options['options'] }
        if (options?.buttons?.length) return this.sendButtons(to, options.buttons, message)
        if (options?.media) return this.sendMedia(to, message, options.media, context)
        const preview_url = options?.preview_url as boolean | undefined
        return this.sendText(to, message, context, preview_url)
    }

    /**
     * Send a document/file message by uploading a local file
     * @param to - Recipient phone number
     * @param mediaInput - Local path to the file
     * @param caption - Optional caption for the document
     * @param context - Optional message ID to reply to
     * @returns Promise with the API response
     * @throws Error if mediaInput is null
     * @example
     * await provider.sendFile('1234567890', '/path/to/document.pdf', 'Here is the report')
     */
    sendFile = async (to: string, mediaInput = null, caption: string, context = null) => {
        to = parseMetaNumber(to)
        if (!mediaInput) throw new Error(`MEDIA_INPUT_NULL_: ${mediaInput}`)

        const formData = new FormData()
        const mimeType = mime.lookup(mediaInput)
        formData.append('file', createReadStream(mediaInput), {
            contentType: mimeType,
        })
        formData.append('messaging_product', 'whatsapp')

        const nameOriginal = basename(mediaInput) || 'Doc'

        const {
            data: { id: mediaId },
        } = await axios.post(
            `${URL}/${this.globalVendorArgs.version}/${this.globalVendorArgs.numberId}/media`,
            formData,
            {
                headers: {
                    Authorization: `Bearer ${this.globalVendorArgs.jwtToken}`,
                    ...formData.getHeaders(),
                },
            }
        )

        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'document',
            document: {
                id: mediaId,
                filename: nameOriginal,
                caption,
            },
        }
        if (context) body.context = { message_id: context }
        return this.sendMessageMeta(body)
    }

    /**
     * Send an audio message by uploading a local file
     * @param to - Recipient phone number
     * @param pathVideo - Local path to the audio file (supports mp3, m4a, aac, amr, ogg - auto-converts to ogg/opus)
     * @param context - Optional message ID to reply to
     * @returns Promise with the API response
     * @throws Error if pathVideo is null
     * @example
     * await provider.sendAudio('1234567890', '/path/to/audio.mp3')
     */
    sendAudio = async (to: string, pathVideo = null, context = null) => {
        to = parseMetaNumber(to)
        if (!pathVideo) throw new Error(`MEDIA_INPUT_NULL_: ${pathVideo}`)

        let audioPath = pathVideo
        const mimeType = mime.lookup(pathVideo)

        // Auto-convert to OGG/Opus if not already in that format (required for voice notes)
        if (!mimeType?.includes('ogg') && !mimeType?.includes('opus')) {
            audioPath = await utils.convertAudio(pathVideo, 'ogg')
        }

        const formData = new FormData()
        formData.append('file', createReadStream(audioPath), {
            contentType: 'audio/ogg',
        })
        formData.append('messaging_product', 'whatsapp')

        const {
            data: { id: mediaId },
        } = await axios.post(
            `${URL}/${this.globalVendorArgs.version}/${this.globalVendorArgs.numberId}/media`,
            formData,
            {
                headers: {
                    Authorization: `Bearer ${this.globalVendorArgs.jwtToken}`,
                    ...formData.getHeaders(),
                },
            }
        )

        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            to,
            type: 'audio',
            audio: {
                id: mediaId,
                voice: true, // Sends as voice note (PTT) instead of audio file
            },
        }
        if (context) body.context = { message_id: context }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a reaction emoji to a specific message
     * @param to - Recipient phone number
     * @param react - Reaction object with message_id and emoji
     * @returns Promise with the API response
     * @example
     * await provider.sendReaction('1234567890', { message_id: 'wamid.xxx', emoji: '👍' })
     */
    sendReaction = async (to: string, react: Reaction) => {
        to = parseMetaNumber(to)
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'reaction',
            reaction: {
                message_id: react.message_id,
                emoji: react.emoji,
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Request location from user (deprecated, use sendLocationRequest instead)
     * @param to - Recipient phone number
     * @param bodyText - Text prompting user to share location
     * @returns Promise with the API response
     * @deprecated Use sendLocationRequest instead
     */
    requestLocation = async (to, bodyText) => {
        to = parseMetaNumber(to)
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'location_request_message',
                body: {
                    text: bodyText,
                },
                action: {
                    name: 'send_location',
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a location message with coordinates
     * @param to - Recipient phone number
     * @param localization - Location object with coordinates, name, and address
     * @returns Promise with the API response
     * @example
     * await provider.sendLocation('1234567890', {
     *   lat_number: '40.7128',
     *   long_number: '-74.0060',
     *   name: 'New York City',
     *   address: 'Manhattan, NY'
     * })
     */
    sendLocation = async (to: string, localization: Localization) => {
        to = parseMetaNumber(to)
        const { long_number, lat_number, name, address } = localization
        const body = {
            messaging_product: 'whatsapp',
            to,
            type: 'location',
            location: {
                name,
                address,
                longitude: long_number,
                latitude: lat_number,
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a location request message prompting user to share their location
     * @param to - Recipient phone number
     * @param bodyText - Text prompting user to share location
     * @returns Promise with the API response
     * @example
     * await provider.sendLocationRequest('1234567890', 'Please share your location for delivery')
     */
    sendLocationRequest = async (to: string, bodyText: string) => {
        to = parseMetaNumber(to)
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'location_request_message',
                body: {
                    text: bodyText,
                },
                action: {
                    name: 'send_location',
                },
            },
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send a plain text message
     * @param to - Recipient phone number
     * @param message - Text message content
     * @param context - Optional message ID to reply to
     * @param preview_url - Whether to show URL previews. Auto-detected when omitted (true if message contains a URL).
     * @returns Promise with the API response
     * @example
     * await provider.sendText('1234567890', 'Hello, how can I help you?')
     *
     * // Auto-detection: preview_url will be true because message has a URL
     * await provider.sendText('1234567890', 'Check https://example.com')
     *
     * // Explicitly enable preview
     * await provider.sendText('1234567890', 'Check https://example.com', null, true)
     *
     * // Explicitly disable preview even with URL
     * await provider.sendText('1234567890', 'See https://example.com', null, false)
     */
    sendText = async (to: string, message: string, context = null, preview_url?: boolean) => {
        to = parseMetaNumber(to)
        const resolvedPreview = preview_url ?? URL_REGEX.test(message)
        const body: TextMessageBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: {
                preview_url: resolvedPreview,
                body: message,
            },
        }
        if (context) body.context = { message_id: context }
        return this.sendMessageMeta(body)
    }

    /**
     * Mark a message as read (shows blue checkmarks)
     * @param wa_id - WhatsApp message ID to mark as read
     * @returns Promise with the API response
     * @example
     * await provider.markAsRead('wamid.HBgLMTIzNDU2Nzg5MA==')
     */
    markAsRead = async (wa_id: string) => {
        const body = {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: wa_id,
        }
        return this.sendMessageMeta(body)
    }

    /**
     * Send presence update to simulate typing indicator using Meta Cloud API format.
     * Requires the message_id of the incoming message that triggered this response.
     * The typing indicator lasts up to 25 seconds or until a message is sent.
     * @param messageId - The wamid of the incoming message (from the user)
     * @returns Promise with the API response
     * @example
     * await provider.sendPresenceUpdate('wamid.HBgLMTIzNDU2Nzg5MA==')
     */
    sendPresenceUpdate = async (messageId: string) => {
        const body = {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId,
            typing_indicator: {
                type: 'text',
            },
        }
        return this.sendMessageToApi(body)
    }

    /**
     * Show a typing indicator to the recipient.
     * Requires the message_id of the incoming message that triggered this response.
     * @param messageId - The wamid of the incoming message (from the user)
     * @param ms - Optional duration in milliseconds to wait (typing indicator disappears automatically after 25s or when a message is sent)
     * @example
     * // Show typing indicator
     * await provider.typing('wamid.HBgLMTIzNDU2Nzg5MA==')
     *
     * // Show typing indicator and wait 3 seconds before continuing
     * await provider.typing('wamid.HBgLMTIzNDU2Nzg5MA==', 3000)
     */
    typing = async (messageId: string, ms?: number): Promise<void> => {
        await this.sendPresenceUpdate(messageId)
        if (ms) {
            await new Promise((resolve) => setTimeout(resolve, ms))
        }
    }

    /**
     * Queue a message to be sent via the Meta API (rate-limited)
     * @param body - Message body conforming to Meta API specification
     * @returns Promise with the API response
     * @example
     * await provider.sendMessageMeta({
     *   messaging_product: 'whatsapp',
     *   to: '1234567890',
     *   type: 'text',
     *   text: { body: 'Hello' }
     * })
     */
    sendMessageMeta = (body: TextMessageBody): Promise<any> => {
        return new Promise((resolve) =>
            this.queue.add(async () => {
                const resp = await this.sendMessageToApi(body)
                resolve(resp)
            })
        )
    }

    /**
     * Send a message directly to the Meta Graph API (bypasses queue)
     * @param body - Message body conforming to Meta API specification
     * @returns Promise with the API response or error
     * @example
     * const response = await provider.sendMessageToApi({
     *   messaging_product: 'whatsapp',
     *   to: '1234567890',
     *   type: 'text',
     *   text: { body: 'Hello' }
     * })
     */
    sendMessageToApi = async (body: TextMessageBody): Promise<any> => {
        const id = body.to ?? body.recipient
        if (id) {
            const address = resolveOutboundAddress(id)
            if ('recipient' in address) {
                body.recipient = address.recipient
                delete body.to
            } else {
                body.to = this.fixPrefixMetaNumber(address.to)
                delete body.recipient
            }
        }
        try {
            const fullUrl = `${URL}/${this.globalVendorArgs.version}/${this.globalVendorArgs.numberId}/messages`
            const response = await axios.post(fullUrl, body, {
                headers: {
                    Authorization: `Bearer ${this.globalVendorArgs.jwtToken}`,
                },
            })
            response.data.payload = body
            return response.data
        } catch (error) {
            return error
        }
    }
}
export { MetaProvider }
