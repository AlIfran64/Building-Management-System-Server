const fs = require("fs");
const key = fs.readFileSync("./brickbase-firebase-adminsdk.json", "utf8");
const base64 = Buffer.from(key).toString("base64");
