import { delay } from './env'
import { ProviderClass } from '../src/index'
import { GlobalVendorArgs } from '../src/types'

class MockProvider extends ProviderClass {
    public globalVendorArgs: GlobalVendorArgs = {
        name: 'mock',
        port: 0,
        version: '1.0.0',
    }

    constructor() {
        super()
    }

    delaySendMessage = async (milliseconds: number, eventName: string, payload: any): Promise<void> => {
        await delay(milliseconds)
        this.emit(eventName, payload)
    }

    sendMessage = async (userId: string, message: string): Promise<any> => {
        console.log(`Enviando... ${userId}, ${message}`)
        return Promise.resolve({ userId, message })
    }

    saveFile = async (_ctx: any, _options?: { path: string }): Promise<string> => 'mock-file'
    protected beforeHttpServerInit(): void {}
    protected afterHttpServerInit(): void {}
    protected busEvents() {
        return []
    }
    protected initVendor() {
        return Promise.resolve({})
    }
}

export default MockProvider
