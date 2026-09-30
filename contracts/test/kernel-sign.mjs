// Deterministic P-256 signer for the forge proof (vm.ffi).
// Fixture JWK generated once on 2026-09-24 via
//   node -e "const {generateKeyPairSync}=require('node:crypto'); \
//     console.log(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))"
// and pinned here so x/y and every signature are reproducible.
import { createPrivateKey, createPublicKey, sign } from "node:crypto";

const JWK = {
  kty: "EC",
  x: "BqjPovesWJOn2eU86PyU1j9LVKlpvYN2w5KCEzAus2Y",
  y: "Ii_D2wwf1j9Rb0hDdPZvMCEM57JNbv48Uk62463QVG4",
  crv: "P-256",
  d: "T4FCxtt1hQgHJSwFv78_S0LGYtVvt73h7-RikHaQ_G8",
};
const priv = createPrivateKey({ key: JWK, format: "jwk" });
const jwk = createPublicKey(priv).export({ format: "jwk" });
const hex = (s) => Buffer.from(s, "base64url").toString("hex");

if (process.argv[2] === "pub") {
  // ABI word(x) ‖ word(y), one hex string.
  process.stdout.write("0x" + hex(jwk.x).padStart(64, "0") + hex(jwk.y).padStart(64, "0"));
} else {
  const msg = Buffer.from(process.argv[3].replace(/^0x/, ""), "hex");
  const sig = sign("sha256", msg, { key: priv, dsaEncoding: "ieee-p1363" });
  process.stdout.write("0x" + sig.toString("hex"));
}
