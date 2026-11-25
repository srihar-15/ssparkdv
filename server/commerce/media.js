import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { getCommerceDb, getCommerceStorage } from './firebase.js';
import { CommerceError, methodAllowed, sendCommerceError } from './http.js';

const mediaIdPattern = /^[a-f0-9-]{36}$/;

function bucket(env) {
  const name = env.COMMERCE_MEDIA_BUCKET || process.env.COMMERCE_MEDIA_BUCKET;
  if (!name) throw new Error('COMMERCE_MEDIA_BUCKET is required for image uploads.');
  return getCommerceStorage(env).bucket(name);
}

export async function uploadAdminMedia(env, body, actor) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(body.type))
    throw new CommerceError(400, 'Upload a JPEG, PNG, WebP, or AVIF image.');
  if (typeof body.dataBase64 !== 'string' || body.dataBase64.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.dataBase64))
    throw new CommerceError(400, 'Upload an image under 5 MB.');
  const input = Buffer.from(body.dataBase64, 'base64');
  if (input.length > 5 * 1024 * 1024 || input.length < 100) throw new CommerceError(400, 'Upload an image under 5 MB.');
  let image;
  try {
    image = await sharp(input, { limitInputPixels: 50_000_000, failOn: 'error' })
      .rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 }).toBuffer({ resolveWithObject: true });
  } catch { throw new CommerceError(400, 'The image could not be processed.'); }
  const id = randomUUID();
  const path = `commerce-media/${id}.webp`;
  await bucket(env).file(path).save(image.data, {
    resumable: false, contentType: 'image/webp', metadata: { cacheControl: 'public, max-age=31536000, immutable' },
  });
  const media = { id, url: `/api/media?id=${id}`, mime: 'image/webp', width: image.info.width,
    height: image.info.height, bytes: image.data.length, path, name: String(body.name || 'image').slice(0, 160),
    uploadedBy: actor.uid, uploadedAt: new Date().toISOString() };
  try {
    const db = getCommerceDb(env);
    const batch = db.batch();
    batch.create(db.collection('media').doc(id), media);
    batch.create(db.collection('auditEvents').doc(randomUUID()), { actorUid: actor.uid, action: 'upload',
      resource: 'media', id, detail: { name: media.name, bytes: media.bytes }, at: media.uploadedAt });
    await batch.commit();
  } catch (error) {
    await bucket(env).file(path).delete().catch(() => {});
    throw error;
  }
  return { media };
}

export function createMediaHandler(env = process.env) {
  return async (req, res) => {
    try {
      methodAllowed(req, ['GET']);
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = url.searchParams.get('id') || '';
      if (!mediaIdPattern.test(id)) throw new CommerceError(400, 'Invalid media ID.');
      const doc = await getCommerceDb(env).collection('media').doc(id).get();
      if (!doc.exists) throw new CommerceError(404, 'Image not found.');
      const [bytes] = await bucket(env).file(doc.data().path).download();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Content-Length', bytes.length);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(bytes);
    } catch (error) { return sendCommerceError(res, error); }
  };
}
