import { addAnswer } from './addAnswer'
import { toJson } from './toJson'
import type { ActionPropertiesKeyword, CallbackFunction, TContext, TFlow } from '../../types'
import { generateRef } from '../../utils/hash'

/**
 * @public
 * @param keyword
 * @param options
 * @returns
 */
const addKeyword = <P = any, B = any>(
    keyword: string | [string, ...string[]],
    options?: ActionPropertiesKeyword
): TFlow<P, B> => {
    if (typeof keyword !== 'string' && !Array.isArray(keyword)) {
        throw new Error('DEBE_SER_STRING_ARRAY_REGEX')
    }

    if (keyword.length === 0) {
        throw new Error('Keyword cannot be empty')
    }

    const parseOptions = (): ActionPropertiesKeyword => {
        const defaultProperties = {
            sensitive: typeof options?.sensitive === 'boolean' ? !!options?.sensitive : false,
            regex: typeof options?.regex === 'boolean' ? !!options?.regex : false,
        }
        return defaultProperties
    }

    const ctxAddKeyword = (): TContext => {
        const ref = `key_${generateRef()}`
        const parsedOptions = parseOptions()
        const json = [
            {
                ref,
                keyword,
                options: parsedOptions,
            },
        ]
        return { ref, keyword, options: parsedOptions, json }
    }

    const ctx = ctxAddKeyword()

    return {
        ctx,
        ref: ctx.ref,
        addAnswer: addAnswer(ctx),
        addAction: (cb: CallbackFunction<P, B> = () => null, flagCb: CallbackFunction<P, B> = () => null) => {
            if (typeof cb === 'object') {
                return addAnswer(ctx)('__capture_only_intended__', cb, flagCb)
            }
            return addAnswer(ctx)('__call_action__', null, cb)
        },
        toJson: toJson(ctx),
    }
}

export { addKeyword }
