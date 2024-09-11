import { GroupAffine } from 'src/bindings/crypto/elliptic-curve.js';
import { Crypto } from './crypto.js';

const Pallas = Crypto.createCurve(Crypto.CurveParams.Pallas);
const G = Pallas.from(Crypto.CurveParams.Pallas.generator);
const H = Pallas.from({
  x: 0x221b959dacd2052aae26193fca36b53279866a4fbbab0d5a2f828b5fd7778201n,
  y: 0x058c8f1105cae57f4891eadc9b85c8954e5067190e155e61d66855ace69c16c0n,
});

function affineToHex(affine: GroupAffine) {
  const x = affine.x.toString(16).padStart(64, '0');
  const y = affine.y.toString(16).padStart(64, '0');
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
