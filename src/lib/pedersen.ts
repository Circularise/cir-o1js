import { GroupAffine } from "src/bindings/crypto/elliptic-curve.js";
import { Crypto } from "./crypto.js";

const Pallas = Crypto.createCurve(Crypto.CurveParams.Pallas);
const G = Pallas.from(Crypto.CurveParams.Pallas.generator);
const H = Pallas.from({
    x: 0x221B959DACD2052AAE26193FCA36B53279866A4FBBAB0D5A2F828B5FD7778201n,
    y: 0x058C8F1105CAE57F4891EADC9B85C8954E5067190E155E61D66855ACE69C16C0n
})

function affineToHex(affine: GroupAffine) {
    const x = affine.x.toString(16).padStart(64, "0");
    const y = affine.y.toString(16).padStart(64, "0");
    return `0x4${x}${y}`;

}
export function commit(x: bigint, r: bigint) {
    const affinePoint = Pallas.add(Pallas.scale(G, x), Pallas.scale(H, r));
    return BigInt(affineToHex(affinePoint));
}

export function verifyCommitment(x: bigint, r: bigint, commitment: bigint) {
    const otherCommitment = commit(x, r);
    return commitment == otherCommitment;
}