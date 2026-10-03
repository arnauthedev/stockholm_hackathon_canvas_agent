// Prints the pairing URL and a terminal QR code.
import qr from "qrcode-terminal";
const [url, token, appPort] = process.argv.slice(2);
const link = `${url.replace(/\/$/, "")}/#token=${encodeURIComponent(token)}`;
console.log("\n  Canvas Agent — open on your phone:\n");
qr.generate(link, { small: true }, (s) => console.log(s.replace(/^/gm, "  ")));
console.log(`  ${link}\n`);
console.log(`  Server dashboard: ${url.replace(/\/$/, "")}/dashboard#token=${encodeURIComponent(token)}\n`);
console.log(`  (laptop: http://localhost:${appPort}/#token=${encodeURIComponent(token)})\n`);
