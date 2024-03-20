import { test } from 'uvu'
import * as assert from 'uvu/assert'

import { httpsMock } from '../__mock__/http'
import { getMediaUrl } from '../src/utils'

const version = 'v1'
const idMedia = '123'
const numberId = '456'
const token = 'myToken'

test('getMediaUrl - should return media url correctly', async () => {
    const url = 'https://example.com/media'
    const responseData = {
        data: {
            url,
        },
    }

    httpsMock.get.resolves(responseData)
    const result = await getMediaUrl(version, idMedia, numberId, token)
    assert.is(result, url)
})

test('getMediaUrl should handle errors and return undefined', async () => {
    httpsMock.get.throws('Some error')
    const result = await getMediaUrl(version, idMedia, numberId, token)
    assert.is(result, undefined)
})

test.run()