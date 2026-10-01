const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const BALE_TOKEN = process.env.BALE_TOKEN;

if (!BALE_TOKEN) {
  console.error("ERROR: BALE_TOKEN is not set.");
  process.exit(1);
}

const PHOTOS_DIR = path.join(__dirname, "photos");
const DATA_DIR = path.join(__dirname, "data");
const JSONL_FILE = path.join(DATA_DIR, "photos.jsonl");

fs.mkdirSync(PHOTOS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

async function bale(method, params = {}) {
  const url = `https://tapi.bale.ai/bot${BALE_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Bale API error: ${JSON.stringify(data)}`);
  }

  return data.result;
}

async function downloadFile(filePath, destination) {
  const url = `https://tapi.bale.ai/file/bot${BALE_TOKEN}/${filePath}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);

  return buffer.length;
}

function pickBestPhoto(message) {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return message.photo.reduce((best, current) => {
      const bestSize = best.file_size || 0;
      const currentSize = current.file_size || 0;
      return currentSize >= bestSize ? current : best;
    });
  }

  if (
    message.document &&
    typeof message.document.mime_type === "string" &&
    message.document.mime_type.startsWith("image/")
  ) {
    return message.document;
  }

  return null;
}

function safeName(name) {
  return String(name || "photo")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

async function processUpdate(update) {
  const message = update.message;

  if (!message) return;

  const photo = pickBestPhoto(message);

  if (!photo) return;

  const chat = message.chat || {};
  const sender = message.from || {};

  const fileInfo = await bale("getFile", {
    file_id: photo.file_id
  });

  const originalName =
    message.document?.file_name ||
    `bale_${update.update_id}.jpg`;

  const extension =
    path.extname(originalName) ||
    ".jpg";

  const photoId = `${chat.id}_${message.message_id}_${Date.now()}`;
  const filename = `${safeName(photoId)}${extension}`;
  const localFile = path.join(PHOTOS_DIR, filename);

  const downloadedBytes = await downloadFile(
    fileInfo.file_path,
    localFile
  );

  const record = {
    photo_id: photoId,
    update_id: update.update_id,
    message_id: message.message_id,

    group_id: chat.id,
    group_name: chat.title || "",
    chat_type: chat.type || "",

    sender_id: sender.id || "",
    sender_name: [sender.first_name, sender.last_name]
      .filter(Boolean)
      .join(" "),

    date_unix: message.date || null,

    file_id: photo.file_id,
    file_path: fileInfo.file_path,

    original_file_name: originalName,
    mime_type: message.document?.mime_type || "image/jpeg",

    width: photo.width || null,
    height: photo.height || null,
    original_file_size: photo.file_size || null,
    downloaded_bytes: downloadedBytes,

    caption: message.caption || "",

    local_file: `photos/${filename}`,

    received_at: new Date().toISOString()
  };

  fs.appendFileSync(
    JSONL_FILE,
    JSON.stringify(record) + "\n",
    "utf8"
  );

  console.log(
    `Processed: ${record.group_name || record.group_id} | ${filename}`
  );
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        ok: true,
        service: "bale-photo-collector"
      })
    );

    return;
  }

  if (
    req.method === "POST" &&
    req.url === "/bale/webhook"
  ) {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", async () => {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify({ ok: true }));

      try {
        const update = JSON.parse(body);

        console.log(
          `Received update: ${update.update_id}`
        );

        await processUpdate(update);
      } catch (error) {
        console.error(
          "Webhook processing error:",
          error
        );
      }
    });

    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json"
  });

  res.end(
    JSON.stringify({
      ok: false,
      error: "Not found"
    })
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Bale photo collector running on port ${PORT}`
  );
});
