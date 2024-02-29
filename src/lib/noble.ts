import { Field } from "./core.js"

export function fieldArrayToBigIntArray(values: Field[]): bigint[] {
    return values.map((f) => f.toBigInt())
}

export function bigintArrayToFieldArray(values: bigint[]): Field[] {
    return values.map((n) => Field(n))
}