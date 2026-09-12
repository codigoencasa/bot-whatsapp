import { utils } from '@builderbot/bot'
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { writeFile } from 'fs/promises'
import mime from 'mime-types'
import path from 'path'
import venom from 'venom-bot'

import { VenomProvider } from '../src'

const phoneNumber = '1234567890'

jest.mock('fs/promises', () => ({
    writeFile: jest.fn(),
}))

jest.mock('../src/utils', () => ({
    venomCleanNumber: jest.fn().mockImplementation(() => phoneNumber),
    venomisValidNumber: jest.fn().mockImplementation(() => true),
    venomGenerateImage: jest.fn(),
    venomDeleteTokens: jest.fn(),
}))

jest.mock('@builderbot/bot')

jest.mock('venom-bot', () => ({
    create: jest.fn(),
}))

describe('#VenomProvider', () => {
    let venomProvider: VenomProvider
    let mockNext: any
    let mockRes: any
    let mockReq: any
    const activeTimers = new Set<any>()
    let originalSetTimeout: typeof setTimeout
    let originalClearTimeout: typeof clearTimeout

    beforeEach(() => {
        // Intercept setTimeout to track all timers
        originalSetTimeout = global.setTimeout
        originalClearTimeout = global.clearTimeout

        global.setTimeout = ((fn: Function, delay?: number, ...args: any[]) => {
            const timer = originalSetTimeout(fn, delay, ...args)
            activeTimers.add(timer)
            return timer
        }) as typeof setTimeout

        global.clearTimeout = ((timer: any) => {
            activeTimers.delete(timer)
            return originalClearTimeout(timer)
        }) as typeof clearTimeout

        venomProvider = new VenomProvider({ name: 'test', gifPlayback: false })
        mockReq = {}
        mockRes = {
            writeHead: jest.fn(),
            end: jest.fn(),
            pipe: jest.fn(),
        }
        mockNext = jest.fn()
        mockNext = jest.fn()
    })

    afterEach(() => {
        jest.clearAllMocks()
        // Clear all tracked timers
        activeTimers.forEach((timer) => {
            originalClearTimeout(timer)
        })
        activeTimers.clear()
        // Restore original functions
        global.setTimeout = originalSetTimeout
        global.clearTimeout = originalClearTimeout
    })

    describe('VenomProvider Constructor', () => {
        test('Initialization with default arguments', () => {
            expect(venomProvider.globalVendorArgs).toEqual({
                name: 'test',
                gifPlayback: false,
                port: 3000,
                writeMyself: 'none',
            })
        })
    })

    describe('#saveFile', () => {
        test('Save file successfully', async () => {
            // Arrange
            const mockedDecryptFile = jest.fn().mockImplementation(() => Buffer.from('fileContent'))
            const ctx = { mimetype: 'image/png' }
            const options = { path: '/tmp' }
            const expectedFilePath = '/tmp/some-file-name.png'

            venomProvider.vendor = {
                decryptFile: mockedDecryptFile,
            } as any
            jest.spyOn(path, 'join').mockImplementation(() => expectedFilePath)
            // Act
            const result = await venomProvider.saveFile(ctx, options)

            // Assert
            expect(result).toContain('some-file-name.png')
            expect(mockedDecryptFile).toHaveBeenCalledWith(ctx)
            expect(writeFile).toHaveBeenCalledWith(expectedFilePath, Buffer.from('fileContent'))
            mockedDecryptFile.mockReset()
        })
    })

    describe('#sendMessage', () => {
        test('Send text message', async () => {
            // Arrange
            const fakeRecipient = '1234567890'
            const fakeMessage = 'Hello, world!'
            const options = {}
            const mockSendText = jest.fn().mockImplementation(() => 'Text message sent')
            venomProvider.vendor = {
                sendText: mockSendText,
            } as any
            jest.spyOn(venomProvider, 'sendButtons')
            jest.spyOn(venomProvider, 'sendMedia')
            // Act
            await venomProvider.sendMessage(fakeRecipient, fakeMessage, options)

            // Assert
            expect(mockSendText).toHaveBeenCalledWith(fakeRecipient, fakeMessage)
            expect(venomProvider.sendButtons).not.toHaveBeenCalled()
            expect(venomProvider.sendMedia).not.toHaveBeenCalled()
        })

        test('should parse the recipient number and send message with buttons', async () => {
            // Arrange
            const fakeRecipient = '1234567890'
            const fakeMessage = 'Choose an option:'
            const fakeButtons = [{ body: 'Option 1' }, { body: 'Option 2' }]
            const fakeOptions = { buttons: fakeButtons }
            jest.spyOn(venomProvider, 'sendButtons').mockResolvedValue(() => true)
            jest.spyOn(venomProvider, 'sendMedia')

            // Act
            await venomProvider.sendMessage(fakeRecipient, fakeMessage, fakeOptions)

            // Assert
            expect(venomProvider.sendButtons).toHaveBeenCalledWith(fakeRecipient, fakeMessage, fakeButtons)
            expect(venomProvider.sendMedia).not.toHaveBeenCalled()
        })

        test('should parse the recipient number and send media message', async () => {
            // Arrange
            const fakeRecipient = '1234567890'
            const fakeMessage = 'Here is a media file'
            const fakeMedia = 'path/to/media.jpg'
            const fakeOptions = { media: fakeMedia }
            jest.spyOn(venomProvider, 'sendButtons')
            jest.spyOn(venomProvider, 'sendMedia').mockResolvedValue(() => true)

            // Act
            await venomProvider.sendMessage(fakeRecipient, fakeMessage, fakeOptions)

            // Assert
            expect(venomProvider.sendMedia).toHaveBeenCalledWith(fakeRecipient, fakeMedia, fakeMessage)
            expect(venomProvider.sendButtons).not.toHaveBeenCalled()
        })
    })

    describe('#sendMedia', () => {
        test('should send image when provided with image URL', async () => {
            // Arrange
            const number = '+123456789'
            const imageUrl = 'https://example.com/image.jpg'
            const text = 'Hello World'
            const fileDownloaded = 'path/to/downloaded/image.jpg'
            ;(utils.generalDownload as jest.MockedFunction<typeof utils.generalDownload>).mockResolvedValue(
                fileDownloaded
            )
            jest.spyOn(mime, 'lookup').mockReturnValue('image/jpeg')
            const sendImageSpy = jest.spyOn(venomProvider, 'sendImage').mockImplementation(async () => true as any)

            // Act
            await venomProvider.sendMedia(number, imageUrl, text)

            // Assert
            expect(sendImageSpy).toHaveBeenCalled()
            expect(utils.generalDownload).toHaveBeenCalledWith(imageUrl)
        })

        test('should send video when provided with video URL', async () => {
            // Arrange
            const number = '+123456789'
            const videoUrl = 'https://example.com/video.mp4'
            const text = 'Hello World'
            const fileDownloaded = 'path/to/downloaded/audio.mp3'
            ;(utils.generalDownload as jest.MockedFunction<typeof utils.generalDownload>).mockResolvedValue(
                fileDownloaded
            )
            jest.spyOn(mime, 'lookup').mockReturnValue('video/mp4')
            const sendVideoSpy = jest.spyOn(venomProvider, 'sendVideo').mockImplementation(async () => true as any)

            // Act
            await venomProvider.sendMedia(number, videoUrl, text)

            // Assert
            expect(sendVideoSpy).toHaveBeenCalled()
            expect(utils.generalDownload).toHaveBeenCalledWith(videoUrl)
        })

        test('should send audio when provided with audio URL', async () => {
            // Arrange
            const number = '+123456789'
            const audioUrl = 'https://example.com/audio.mp3'
            const text = 'Hello World'
            const fileDownloaded = 'path/to/downloaded/audio.mp3'
            ;(utils.generalDownload as jest.MockedFunction<typeof utils.generalDownload>).mockResolvedValue(
                fileDownloaded
            )
            jest.spyOn(mime, 'lookup').mockReturnValue('audio/mp3')
            const sendAudioSpy = jest.spyOn(venomProvider, 'sendAudio').mockImplementation(async () => undefined)
            // Act
            await venomProvider.sendMedia(number, audioUrl, text)

            // Assert
            expect(sendAudioSpy).toHaveBeenCalled()
            expect(utils.generalDownload).toHaveBeenCalledWith(audioUrl)
        })

        test('should send file when provided with file URL', async () => {
            // Arrange
            const number = '+123456789'
            const fileUrl = 'https://example.com/test.pdf'
            const text = 'Hello World'
            const fileDownloaded = 'path/to/downloaded/test.pdf'
            ;(utils.generalDownload as jest.MockedFunction<typeof utils.generalDownload>).mockResolvedValue(
                fileDownloaded
            )
            jest.spyOn(mime, 'lookup').mockReturnValue('text/plain')
            const sendFileSpy = jest.spyOn(venomProvider, 'sendFile').mockImplementation(async () => undefined)
            // Act
            await venomProvider.sendMedia(number, fileUrl, text)

            // Assert
            expect(sendFileSpy).toHaveBeenCalled()
            expect(utils.generalDownload).toHaveBeenCalledWith(fileUrl)
        })
    })

    describe('#sendVideo', () => {
        test('Send video as GIF', async () => {
            // Arrange
            venomProvider.vendor = {
                sendVideoAsGif: jest.fn().mockImplementation(() => 'Video sent'),
            } as any
            const number = '+123456789'
            const filePath = '/path/to/video.mp4'
            const text = 'Check out this video'
            // Act
            const result = await venomProvider.sendVideo(number, filePath, text)

            // Assert
            expect(result).toEqual('Video sent')
            expect(venomProvider.vendor.sendVideoAsGif).toHaveBeenCalledWith(number, filePath, 'video.gif', text)
        })
    })

    describe('#sendFile', () => {
        test('Send file successfully', async () => {
            // Arrange
            venomProvider.vendor = {
                sendFile: jest.fn().mockImplementation(() => 'File sent'),
            } as any
            const number = '+123456789'
            const filePath = '/path/to/file.txt'
            const text = 'Check out this file'
            jest.spyOn(path, 'basename').mockImplementation(() => filePath)

            // Act
            const result = await venomProvider.sendFile(number, filePath, text)

            // Assert
            expect(result).toEqual('File sent')
            expect(venomProvider.vendor.sendFile).toHaveBeenCalledWith(number, filePath, filePath, text)
        })
    })

    describe('#sendImage', () => {
        test('Send image successfully', async () => {
            // Arrange
            venomProvider.vendor = {
                sendImage: jest.fn().mockImplementation(() => 'Image sent'),
            } as any
            const number = '+123456789'
            const filePath = '/path/to/image.png'
            const text = 'Check out this image'
            jest.spyOn(path, 'basename').mockImplementation(() => filePath)

            // Act
            const result = await venomProvider.sendImage(number, filePath, text)

            // Assert
            expect(result).toEqual('Image sent')
            expect(venomProvider.vendor.sendImage).toHaveBeenCalledWith(number, filePath, filePath, text)
        })
    })

    describe('#sendAudio', () => {
        test('Send audio successfully', async () => {
            // Arrange
            venomProvider.vendor = {
                sendVoice: jest.fn().mockImplementation(() => 'Audio sent'),
            } as any
            const number = '+123456789'
            const audioPath = '/path/to/audio.mp3'
            jest.spyOn(path, 'basename').mockImplementation(() => audioPath)
            // Act
            const result = await venomProvider.sendAudio(number, audioPath)

            // Assert
            expect(result).toEqual('Audio sent')
            expect(venomProvider.vendor.sendVoice).toHaveBeenCalledWith(number, audioPath)
        })
    })

    describe('#sendButtons', () => {
        test('Send buttons successfully', async () => {
            // Arrange
            venomProvider.emit = jest.fn()
            venomProvider.vendor = {
                sendText: jest.fn().mockImplementation(() => 'Buttons sent'),
            } as any
            const number = '+123456789'
            const message = 'Message with buttons'
            const buttons = [{ body: 'Button 1' }, { body: 'Button 2' }]

            // Act
            const result = await venomProvider.sendButtons(number, message, buttons)

            // Assert
            expect(result).toEqual('Buttons sent')
            expect(venomProvider.emit).toHaveBeenCalledWith('notice', {
                title: 'DEPRECATED',
                instructions: [
                    `Currently sending buttons is not available with this provider`,
                    `this function is available with Meta or Twilio`,
                ],
            })

            expect(venomProvider.vendor.sendText).toHaveBeenCalledWith(
                number,
                'Message with buttons\nButton 1\nButton 2'
            )
        })
    })

    describe('#busEvents', () => {
        test('Should return undefine if the from status@broadcast', () => {
            // Arrange
            const message: any = {
                from: 'status@broadcast',
            }
            // Act
            const resul = venomProvider['busEvents']()[0].func(message)

            // Assert
            expect(resul).toBeUndefined()
        })

        test('Should return undefine if the from status@broadcast', () => {
            // Arrange
            const message: any = {
                from: phoneNumber,
            }
            ;(require('../src/utils').venomisValidNumber as jest.Mock).mockImplementation(() => false)
            // Act
            const resul = venomProvider['busEvents']()[0].func(message)

            // Assert
            expect(resul).toBeUndefined()
        })

        test('Set body property for image or video type', () => {
            // Arrange
            const message: any = {
                type: 'image',
                from: phoneNumber,
            }
            const mockEmit = jest.fn()
            const mockEventEmitter = {
                emit: mockEmit,
            }
            venomProvider.emit = (mockEventEmitter as any).emit.bind(mockEventEmitter)
            const refProvider = '_event_voice_note_test'
            ;(require('../src/utils').venomisValidNumber as jest.Mock).mockImplementation(() => true)
            ;(utils.generateRefProvider as jest.MockedFunction<typeof utils.generateRefProvider>).mockImplementation(
                () => refProvider
            )
            // Act
            venomProvider['busEvents']()[0].func(message)

            // Assert
            expect(mockEmit).toHaveBeenCalled()
            expect(utils.generateRefProvider).toHaveBeenCalledWith('_event_media_')
        })
        test('Set body property for document type', () => {
            // Arrange
            const message: any = {
                type: 'document',
                from: phoneNumber,
            }
            const mockEmit = jest.fn()
            const mockEventEmitter = {
                emit: mockEmit,
            }
            venomProvider.emit = (mockEventEmitter as any).emit.bind(mockEventEmitter)
            const refProvider = '_event_document_test'
            ;(require('../src/utils').venomisValidNumber as jest.Mock).mockImplementation(() => true)
            ;(utils.generateRefProvider as jest.MockedFunction<typeof utils.generateRefProvider>).mockImplementation(
                () => refProvider
            )
            // Act
            venomProvider['busEvents']()[0].func(message)

            // Assert
            expect(mockEmit).toHaveBeenCalled()
            expect(utils.generateRefProvider).toHaveBeenCalledWith('_event_document_')
        })

        test('Set body property for ptt type', () => {
            // Arrange
            const message: any = {
                type: 'ptt',
                from: phoneNumber,
            }
            const mockEmit = jest.fn()
            const mockEventEmitter = {
                emit: mockEmit,
            }
            venomProvider.emit = (mockEventEmitter as any).emit.bind(mockEventEmitter)
            const refProvider = '_event_voice_note_test'
            ;(require('../src/utils').venomisValidNumber as jest.Mock).mockImplementation(() => true)
            ;(utils.generateRefProvider as jest.MockedFunction<typeof utils.generateRefProvider>).mockImplementation(
                () => refProvider
            )
            // Act
            venomProvider['busEvents']()[0].func(message)

            // Assert
            expect(mockEmit).toHaveBeenCalled()
            expect(utils.generateRefProvider).toHaveBeenCalledWith('_event_voice_note_')
        })

        test('Set body property for lat and  lng type', () => {
            // Arrange
            const message: any = {
                lat: '1224',
                lng: '1224',
                from: phoneNumber,
            }
            const mockEmit = jest.fn()
            const mockEventEmitter = {
                emit: mockEmit,
            }
            venomProvider.emit = (mockEventEmitter as any).emit.bind(mockEventEmitter)
            const refProvider = '_event_location_test'
            ;(require('../src/utils').venomisValidNumber as jest.Mock).mockImplementation(() => true)
            ;(utils.generateRefProvider as jest.MockedFunction<typeof utils.generateRefProvider>).mockImplementation(
                () => refProvider
            )
            // Act
            venomProvider['busEvents']()[0].func(message)

            // Assert
            expect(mockEmit).toHaveBeenCalled()
            expect(utils.generateRefProvider).toHaveBeenCalledWith('_event_location_')
        })
    })

    describe('#generateQr', () => {
        test('Generate QR code successfully', async () => {
            // Arrange
            const mockEmit = jest.fn()
            const mockEventEmitter = {
                emit: mockEmit,
            }
            venomProvider.emit = (mockEventEmitter as any).emit.bind(mockEventEmitter)
            venomProvider.getListRoutes = jest.fn().mockReturnValue(['Route 1', 'Route 2']) as any
            const mockQr = 'mockedQRCode'
            ;(require('../src/utils').venomGenerateImage as jest.Mock).mockImplementation(() => true)
            // Act
            await venomProvider.generateQr(mockQr)
            // Assert

            expect(mockEmit).toHaveBeenCalledWith('notice', {
                title: '🛜  HTTP Server ON ',
                instructions: ['Route 1', 'Route 2'],
            })

            expect(mockEmit).toHaveBeenCalledWith('require_action', {
                title: '⚡⚡ ACTION REQUIRED ⚡⚡',
                instructions: [
                    'You must scan the QR Code',
                    'Remember that the QR code updates every minute',
                    'Need help: https://link.codigoencasa.com/DISCORD',
                ],
                payload: { qr: mockQr },
            })
        })
    })

    describe('#indexHome', () => {
        test('should send the correct image file', () => {
            // Arrange
            const mockedReadStream = jest.fn()
            const mockedFileStream = { pipe: jest.fn() }
            mockedReadStream.mockReturnValueOnce(mockedFileStream)
            require('fs').createReadStream = mockedReadStream
            require('fs').existsSync = jest.fn().mockReturnValue(true)
            const req = { params: { idBotName: 'bot123' } }
            const res = { writeHead: jest.fn(), end: jest.fn() }
            const expectedImagePath = 'ruta/esperada/bot123.qr.png'
            const mockedJoin = jest.spyOn(path, 'join')
            mockedJoin.mockReturnValueOnce(expectedImagePath)

            // Act
            venomProvider['indexHome'](req as any, res as any, mockNext)
            // Assert
            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'image/png' })
        })

        test('should return 404 when QR image is not generated', () => {
            // Arrange
            require('fs').existsSync = jest.fn().mockReturnValue(false)
            const req = { params: { idBotName: 'bot123' } }
            const res = { writeHead: jest.fn(), end: jest.fn() }
            const expectedImagePath = 'ruta/esperada/bot123.qr.png'
            const mockedJoin = jest.spyOn(path, 'join')
            mockedJoin.mockReturnValueOnce(expectedImagePath)

            // Act
            venomProvider['indexHome'](req as any, res as any, mockNext)
            // Assert
            expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' })
            expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'QR code not generated yet' }))
        })
    })

    describe('#beforeHttpServerInit', () => {
        test('beforeHttpServerInit - you should configure middleware to handle HTTP requests', () => {
            // Arrange
            const mockUse = jest.fn().mockReturnThis()
            const mockGet = jest.fn()

            const mockPolka = jest.fn(() => ({
                use: mockUse,
                get: mockGet,
            }))

            venomProvider.server = mockPolka() as any
            // Act
            venomProvider['beforeHttpServerInit']()

            // Assert
            expect(mockUse).toHaveBeenCalled()
            const middleware = mockUse.mock.calls[0][0] as any
            expect(middleware).toBeInstanceOf(Function)
            middleware(mockReq, mockRes, mockNext)
            expect(mockReq.globalVendorArgs).toBe(venomProvider.globalVendorArgs)
            expect(mockGet).toHaveBeenCalledWith('/', venomProvider.indexHome)
        })
    })

    describe('#listenOnEvents', () => {
        test('Assign events correctly', () => {
            // Arrange
            const mockVendor = {
                onMessage: jest.fn(),
                onIncomingCall: jest.fn(),
            } as any
            venomProvider.vendor = mockVendor
            const mockEvents = [{ event: 'onMessage', func: jest.fn() }]
            venomProvider.busEvents = jest.fn().mockReturnValue(mockEvents) as any

            // Act
            venomProvider['listenOnEvents'](mockVendor)

            // Assert
            mockEvents.forEach(({ event }) => {
                if (mockVendor[event]) {
                    expect(mockVendor[event]).toHaveBeenCalled()
                    mockVendor[event]({ from: 'sender@example.com', name: 'Sender Name' })
                }
            })
        })

        test('Throw error if vendor is empty', () => {
            // Arrange
            venomProvider.vendor = null as any

            // Act & Assert
            expect(() => venomProvider['listenOnEvents'](null as any)).toThrow('Vendor should not return empty')
        })

        test('Set vendor when not defined', () => {
            // Arrange
            const mockVendor = {
                onMessage: jest.fn(),
            } as any

            // Act
            venomProvider['listenOnEvents'](mockVendor)

            // Assert
            expect(venomProvider.vendor).toEqual(mockVendor)
        })
    })

    describe('#initVendor', () => {
        test('should initialize the vendor successfully', async () => {
            // Arrange
            const mockHostDevice = { id: { user: 'mockUserId' }, pushname: 'mockPushName' }
            ;(venom.create as jest.Mock).mockImplementationOnce((_, qrCallback, statusCallback, options) => {
                return Promise.resolve({
                    getHostDevice: async () => mockHostDevice,
                    onIncomingCall: jest.fn(),
                } as any)
            })

            // Act
            await venomProvider['initVendor']()

            // Assert
            expect(venom.create).toHaveBeenCalled()
            expect(venomProvider.vendor).toBeDefined()
        })

        test('should handle initialization error', async () => {
            // Arrange
            ;(require('../src/utils').venomDeleteTokens as jest.Mock).mockImplementation(() => false)
            const mockEmit = jest.fn()
            const mockEventEmitter = {
                emit: mockEmit,
            }
            venomProvider.emit = (mockEventEmitter as any).emit.bind(mockEventEmitter)
            ;(venom.create as jest.Mock).mockImplementationOnce(() => {
                return Promise.reject(new Error('Initialization failed'))
            })

            // Act
            await venomProvider['initVendor']()

            // Assert
            expect(venom.create).toHaveBeenCalled()
            expect(mockEmit).toHaveBeenCalled()
            // The setTimeout created in the error handler will be automatically cleaned up in afterEach
        })
    })
})
