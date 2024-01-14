import { test } from 'uvu'
import * as assert from 'uvu/assert'
import { join } from 'path'
import { promises as fsPromises } from 'fs'
import { JsonFileAdapter } from '../src/jsonAdapter'
import { HistoryEntry, JsonFileAdapterOptions } from '../src/types'

const entryMock: HistoryEntry = {
    ref: 'mockRef',
    keyword: 'mockKeyword',
    answer: 'mockAnswer',
    refSerialize: 'mockRefSerialize',
    from: '123456',
    options: {
        mockOption: 'value',
    },
}

const jsonFileAdapterOptions: JsonFileAdapterOptions = { filename: 'test-db.json' }

const filenameDbInit = 'test.json'

const jsonFileAdapter = new JsonFileAdapter(jsonFileAdapterOptions)

async function fileExists(hasFile: boolean): Promise<boolean> {
    return hasFile
}

test.before(async () => {
    await jsonFileAdapter.save(entryMock)
})

test.after(async () => {
    const pathFile = join(process.cwd(), jsonFileAdapterOptions.filename)
    await fsPromises.unlink(pathFile)
})

test('[JsonFileAdapter] - instantiation', () => {
    assert.instance(jsonFileAdapter, JsonFileAdapter)
    assert.equal(jsonFileAdapter['options'], jsonFileAdapterOptions)
})

test('#init - creates a file if it does not exist', async () => {
    const filename = 'test.json'
    const testFilePath = join(process.cwd(), filename)
    const jsonFileAdapter = new JsonFileAdapter({ filename })
    const fileExistsBeforeInit = await fileExists(false)
    assert.is(fileExistsBeforeInit, false)

    await jsonFileAdapter['init']()

    const fileExistsAfterInit = await fileExists(true)
    assert.is(fileExistsAfterInit, true)
    await fsPromises.unlink(testFilePath)
})

test('validateJson - returns parsed JSON for valid input', () => {
    const validJsonString = '{"key": "value"}'
    const result = jsonFileAdapter['validateJson'](validJsonString)
    assert.equal(result, { key: 'value' })
})

test('validateJson - returns an empty object for invalid input', () => {
    const invalidJsonString = 'this is not valid JSON'
    const result = jsonFileAdapter['validateJson'](invalidJsonString)
    assert.equal(result, {})
})

test('readFileAndParse - returns parsed JSON for valid file content', async () => {
    const result = await jsonFileAdapter['readFileAndParse']()
    assert.equal(result.length, 1)
    assert.equal(result[0].keyword, entryMock.keyword)
})

test('getPrevByNumber - returns the correct entry for valid history', async () => {
    const result = await jsonFileAdapter.getPrevByNumber(entryMock.from)
    assert.equal(result?.keyword, entryMock.keyword)
})

test('getPrevByNumber - returns undefined for empty history', async () => {
    const result = await jsonFileAdapter.getPrevByNumber('system')
    assert.equal(result, undefined)
})

test('save adds an entry to the file', async () => {
    const entry: HistoryEntry = {
        ...entryMock,
    }
    const filename = 'test-db-save.json'
    const testFilePath = join(process.cwd(), filename)
    const jsonFileAdapter = new JsonFileAdapter({ filename })

    await jsonFileAdapter.save(entry)
    const contentAfterSave = await fsPromises.readFile(testFilePath, 'utf-8')
    const parsedContent = JSON.parse(contentAfterSave)

    assert.equal(parsedContent.length, 1)
    assert.equal(parsedContent[0].keyword, entry.keyword)
    await fsPromises.unlink(testFilePath)
})

test.run()