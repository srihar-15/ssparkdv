import { products } from '../src/data.js';
import { getCommerceDb } from '../server/commerce/firebase.js';

const apply = process.argv.includes('--apply');
const publishEnquiry = process.argv.includes('--publish-enquiry');
const project = process.env.COMMERCE_FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;

if (!project) {
  console.error('Set COMMERCE_FIREBASE_PROJECT_ID or VITE_FIREBASE_PROJECT_ID first.');
  process.exit(1);
}

const preview = products.map((product, index) => ({
  ...product,
  sku: product.slug,
  pricePaise: product.price == null ? null : Math.round(product.price * 100),
  purchaseMode: product.coming ? 'coming' : 'enquiry',
  sortOrder: index,
}));

console.log(`${apply ? 'Seeding' : 'Previewing'} ${preview.length} legacy products in ${project}/commerce.`);
console.log('Online purchase stays disabled until an administrator confirms HSN, GST rate, weight, dimensions, and stock.');
for (const product of preview) console.log(`${product.slug}: ${product.name} (${product.purchaseMode})`);
if (!apply) {
  console.log('Use --apply to create drafts. Add --publish-enquiry to display them in the storefront. Existing documents are preserved.');
  process.exit(0);
}

const db = getCommerceDb();
let created = 0;
let preserved = 0;
for (const product of preview) {
  const { slug, sku } = product;
  const draftRef = db.collection('productDrafts').doc(slug);
  const publishedRef = db.collection('publishedProducts').doc(slug);
  const inventoryRef = db.collection('inventory').doc(sku);
  const indexRef = db.collection('skuIndex').doc(sku);
  const [draft, published, inventory, index] = await Promise.all([
    draftRef.get(), publishedRef.get(), inventoryRef.get(), indexRef.get(),
  ]);
  const batch = db.batch();
  const now = new Date().toISOString();
  if (!draft.exists) {
    batch.create(draftRef, { ...product, status: 'draft', createdAt: now, migrationSource: 'src/data.js' });
    created++;
  } else preserved++;
  if (!inventory.exists) batch.create(inventoryRef, { sku, onHand: 0, reserved: 0, updatedAt: now });
  if (publishEnquiry && !published.exists) {
    batch.create(publishedRef, { ...product, status: 'published', version: 1,
      publishedAt: now, migrationSource: 'src/data.js' });
  }
  if (publishEnquiry && !index.exists) batch.create(indexRef, { sku, slug });
  await batch.commit();
}
console.log(`Created ${created} drafts; preserved ${preserved} existing drafts.`);
