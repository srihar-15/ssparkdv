import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowUpRight, ClipboardList, FileText, LayoutDashboard, Package, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Tags, Truck, Users } from 'lucide-react';
import { money } from './data.js';
import { useAuth } from './components/auth-provider';
import { adminRead, adminWrite } from './lib/admin-api';
import { orderRequest } from './lib/orders';
import { orderReference, orderCheckpoints } from './lib/order-status';
import './admin.css';

const storefront = location.hostname === 'app.localhost' ? 'http://localhost:5173' : 'https://sparkdv.com';
const emptyProduct = { slug: '', sku: '', name: '', family: '', familySlug: '', category: '', eyebrow: '', img: '', shareImage: '', desc: '', tags: [], features: [], variant: '', price: '', compare: '', purchaseMode: 'enquiry', hsn: '', gstRateBps: '', weightGrams: '', dimensionsCm: { length: '', width: '', height: '' }, professional: false, coming: false, sortOrder: 9999 };
const homeDefaults = { heroProductSlugs: [], metrics: [], partners: [], testimonials: [] };
const roleOptions = ['catalog', 'fulfillment', 'support', 'finance'];

function canAccess(user, permission) {
  return user?.permissions?.includes('*') || user?.permissions?.includes(permission);
}

function Field({ label, children }) {
  return <label className="admin-field"><span>{label}</span>{children}</label>;
}

function TextInput({ value, onChange, ...props }) {
  return <input value={value ?? ''} onChange={event => onChange(event.target.value)} {...props} />;
}

function parseList(text, delimiter = ',') {
  return text.split(delimiter).map(value => value.trim()).filter(Boolean);
}

function ProductEditor({ product, onSave, onUpload, busy, onCancel }) {
  const [item, setItem] = useState({ ...emptyProduct, ...product, dimensionsCm: { ...emptyProduct.dimensionsCm, ...product?.dimensionsCm } });
  const [tags, setTags] = useState((product?.tags || []).join(', '));
  const [features, setFeatures] = useState((product?.features || []).join('\n'));
  const [uploading, setUploading] = useState(false);
  const set = (key, value) => setItem(current => ({ ...current, [key]: value }));
  const setDimension = (key, value) => setItem(current => ({ ...current, dimensionsCm: { ...current.dimensionsCm, [key]: value } }));
  async function upload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try { const url = await onUpload(file); if (url) set('img', url); }
    finally { setUploading(false); event.target.value = ''; }
  }
  function submit(event) {
    event.preventDefault();
    const price = item.price === '' || item.price == null ? null : Number(item.price);
    const dimensionsCm = Object.fromEntries(['length', 'width', 'height'].map(key => [key, Number(item.dimensionsCm[key] || 0)]));
    onSave({
      slug: item.slug.trim().toLowerCase(), sku: item.sku.trim(), name: item.name.trim(), family: item.family.trim(), familySlug: item.familySlug.trim(),
      category: item.category.trim(), eyebrow: item.eyebrow.trim(), img: item.img.trim(), shareImage: item.shareImage.trim(),
      desc: item.desc.trim(), tags: parseList(tags), features: parseList(features, '\n'), variant: item.variant.trim(),
      price, pricePaise: price == null ? null : Math.round(price * 100), compare: item.compare === '' ? null : Number(item.compare),
      purchaseMode: item.purchaseMode, hsn: item.hsn.trim(), gstRateBps: Number(item.gstRateBps || 0), weightGrams: Number(item.weightGrams || 0),
      dimensionsCm, professional: Boolean(item.professional), coming: item.purchaseMode === 'coming' || Boolean(item.coming), sortOrder: Number(item.sortOrder || 9999),
    });
  }
  return <form className="admin-editor admin-card" onSubmit={submit}>
    <div className="admin-card-head"><div><p className="admin-kicker">PRODUCT DRAFT</p><h2>{product?.slug ? `Edit ${product.name}` : 'New product'}</h2></div><button type="button" className="admin-secondary" onClick={onCancel}>Close</button></div>
    <div className="admin-form-grid">
      <Field label="URL slug *"><TextInput value={item.slug} onChange={value => set('slug', value)} required pattern="[a-z0-9]+(-[a-z0-9]+)*" disabled={Boolean(product?.slug)} /></Field>
      <Field label="SKU"><TextInput value={item.sku} onChange={value => set('sku', value)} placeholder="NANION-LITE" /></Field>
      <Field label="Product name *"><TextInput value={item.name} onChange={value => set('name', value)} required /></Field>
      <Field label="Category *"><TextInput value={item.category} onChange={value => set('category', value)} required /></Field>
      <Field label="Family"><TextInput value={item.family} onChange={value => set('family', value)} /></Field>
      <Field label="Family URL slug"><TextInput value={item.familySlug} onChange={value => set('familySlug', value)} /></Field>
      <Field label="Eyebrow"><TextInput value={item.eyebrow} onChange={value => set('eyebrow', value)} /></Field>
      <Field label="Variant"><TextInput value={item.variant} onChange={value => set('variant', value)} /></Field>
      <Field label="Purchase mode"><select value={item.purchaseMode || 'enquiry'} onChange={event => set('purchaseMode', event.target.value)}><option value="online">Online checkout</option><option value="enquiry">Enquiry only</option><option value="coming">Coming soon</option></select></Field>
      <Field label="Price in ₹"><TextInput type="number" min="0" step="0.01" value={item.price} onChange={value => set('price', value)} /></Field>
      <Field label="Compare at ₹"><TextInput type="number" min="0" step="0.01" value={item.compare} onChange={value => set('compare', value)} /></Field>
      <Field label="Display order"><TextInput type="number" min="0" step="1" value={item.sortOrder} onChange={value => set('sortOrder', value)} /></Field>
      <Field label="Product image URL *"><TextInput value={item.img} onChange={value => set('img', value)} placeholder="/api/media?id=… or image.svg" required /></Field>
      <Field label="Upload image"><input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={upload} disabled={uploading || busy} />{uploading && <small>Uploading…</small>}</Field>
      <Field label="Share image URL"><TextInput value={item.shareImage} onChange={value => set('shareImage', value)} /></Field>
      <Field label="HSN code"><TextInput value={item.hsn} onChange={value => set('hsn', value)} inputMode="numeric" pattern="[0-9]*" /></Field>
      <Field label="GST rate (basis points; 1800 = 18%)"><TextInput type="number" min="0" max="10000" step="1" value={item.gstRateBps} onChange={value => set('gstRateBps', value)} /></Field>
      <Field label="Shipping weight (grams)"><TextInput type="number" min="0" step="1" value={item.weightGrams} onChange={value => set('weightGrams', value)} /></Field>
      {['length', 'width', 'height'].map(key => <Field key={key} label={`Package ${key} (cm)`}><TextInput type="number" min="0" step="0.1" value={item.dimensionsCm[key]} onChange={value => setDimension(key, value)} /></Field>)}
      <Field label="Tags, separated by commas"><TextInput value={tags} onChange={setTags} /></Field>
      <Field label="Features, one per line"><textarea value={features} onChange={event => setFeatures(event.target.value)} rows={4} /></Field>
      <Field label="Short description"><textarea value={item.desc} onChange={event => set('desc', event.target.value)} rows={4} /></Field>
      <div className="admin-field admin-checkboxes"><label><input type="checkbox" checked={Boolean(item.professional)} onChange={event => set('professional', event.target.checked)} />Professional use</label></div>
    </div>
    <p className="admin-form-note">Online products need a price, HSN, GST rate, weight, dimensions and stock before checkout is available. Save the draft, then publish it.</p>
    <div className="admin-form-actions"><button className="admin-primary" disabled={busy || uploading} type="submit">{busy ? 'Saving…' : 'Save draft'}</button></div>
  </form>;
}

function InventoryPanel({ items, canAdjust, onAction, busy }) {
  const [sku, setSku] = useState('');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  async function submit(event) {
    event.preventDefault();
    const saved = await onAction('inventory', 'adjust', { sku, delta: Number(delta), reason: reason.trim() }, 'Stock adjusted.');
    if (saved) { setDelta(''); setReason(''); }
  }
  return <>
    <section className="admin-card admin-catalog"><div className="admin-card-head"><div><p className="admin-kicker">INVENTORY</p><h2>Stock by SKU</h2></div></div>
      <div className="admin-table-scroll"><table><thead><tr><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Updated</th></tr></thead><tbody>{items.map(item => <tr key={item.sku || item.id}><td><strong>{item.sku || item.id}</strong></td><td>{item.onHand ?? 0}</td><td>{item.reserved ?? 0}</td><td>{Math.max(0, Number(item.onHand || 0) - Number(item.reserved || 0))}</td><td>{item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('en-IN') : '—'}</td></tr>)}</tbody></table></div>
      {!items.length && <p className="admin-empty">No inventory records yet. Publishing a product creates its SKU with zero stock.</p>}
    </section>
    {canAdjust && <form className="admin-card admin-editor" onSubmit={submit}><div className="admin-card-head"><div><p className="admin-kicker">AUDITED MOVEMENT</p><h2>Adjust stock</h2></div></div><div className="admin-form-grid">
      <Field label="SKU"><select required value={sku} onChange={event => setSku(event.target.value)}><option value="">Select a SKU</option>{items.map(item => <option key={item.sku || item.id} value={item.sku || item.id}>{item.sku || item.id}</option>)}</select></Field>
      <Field label="Change in units (+ or −)"><TextInput type="number" step="1" value={delta} onChange={setDelta} required /></Field>
      <Field label="Reason"><TextInput value={reason} onChange={setReason} minLength={3} maxLength={400} required /></Field>
    </div><div className="admin-form-actions"><button className="admin-primary" disabled={busy || !sku}>Record adjustment</button></div></form>}
  </>;
}

function HomeListEditor({ label, rows, fields, onChange }) {
  const list = Array.isArray(rows) ? rows : [];
  const update = (index, key, value) => onChange(list.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
  return <fieldset className="admin-list-editor"><legend>{label}</legend>{list.map((row, index) => <div className="admin-list-row" key={index}>{fields.map(([key, title]) => <Field key={key} label={title}><TextInput value={row[key]} onChange={value => update(index, key, value)} /></Field>)}<button type="button" className="admin-secondary" onClick={() => onChange(list.filter((_, rowIndex) => rowIndex !== index))}>Remove</button></div>)}<button type="button" className="admin-secondary" onClick={() => onChange([...list, Object.fromEntries(fields.map(([key]) => [key, '']))])}>Add {label.toLowerCase().replace(/s$/, '')}</button></fieldset>;
}

function ContentPanel({ items, products, canWrite, canPublish, onAction, busy }) {
  const [key, setKey] = useState('home');
  const [page, setPage] = useState(homeDefaults);
  const [advanced, setAdvanced] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [selected, setSelected] = useState(false);
  const [newKey, setNewKey] = useState('');
  const current = items.find(item => (item.id || item.key) === key);
  useEffect(() => {
    if (selected || !current) return;
    const clean = { ...current };
    for (const field of ['id', 'status', 'version', 'publishedAt', 'publishedBy', 'updatedAt', 'updatedBy', 'hasDraft', 'publishedVersion']) delete clean[field];
    setPage(clean);
    setAdvanced(JSON.stringify(clean, null, 2));
    setSelected(true);
  }, [current, selected]);
  function select(item) {
    const clean = item ? { ...item } : key === 'home' ? homeDefaults : { title: '', sections: [], seo: { title: '', description: '' } };
    for (const field of ['id', 'status', 'version', 'publishedAt', 'publishedBy', 'updatedAt', 'updatedBy', 'hasDraft', 'publishedVersion']) delete clean[field];
    setKey(item?.id || item?.key || 'home'); setPage(clean); setAdvanced(JSON.stringify(clean, null, 2)); setJsonError(''); setSelected(true);
  }
  const setField = (field, value) => setPage(currentPage => ({ ...currentPage, [field]: value }));
  function applyJson() {
    try { const parsed = JSON.parse(advanced); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Use a JSON object.'); setPage(parsed); setJsonError(''); }
    catch (failure) { setJsonError(failure.message); }
  }
  return <>
    <section className="admin-card admin-catalog"><div className="admin-card-head"><div><p className="admin-kicker">CONTENT</p><h2>Pages and campaigns</h2></div></div><div className="admin-record-list">{items.map(item => <button type="button" key={item.id || item.key} className={key === (item.id || item.key) ? 'active' : ''} onClick={() => select(item)}><strong>{item.title || item.id || item.key}</strong><small>{item.hasDraft ? 'Draft ready' : 'Published'}{item.publishedVersion ? ` · Version ${item.publishedVersion}` : ''}</small></button>)}{!items.some(item => (item.id || item.key) === 'home') && <button type="button" onClick={() => { setKey('home'); setPage(homeDefaults); setSelected(true); }}>Home page · new draft</button>}</div>{canWrite && <div className="admin-new-page"><label htmlFor="new-page-key">New page key</label><input id="new-page-key" value={newKey} onChange={event => setNewKey(event.target.value.toLowerCase())} placeholder="about, science, privacy…" pattern="[a-z0-9][a-z0-9-]*" /><button type="button" className="admin-secondary" disabled={!/^[a-z0-9][a-z0-9-]*$/.test(newKey)} onClick={() => { setKey(newKey); const blank = newKey === 'home' ? homeDefaults : { title: '', lede: '', sections: [], seo: { title: '', description: '' } }; setPage(blank); setAdvanced(JSON.stringify(blank, null, 2)); setSelected(true); setNewKey(''); }}>Create draft</button></div>}</section>
    {canWrite && <form className="admin-card admin-editor" onSubmit={event => { event.preventDefault(); onAction('content', 'saveDraft', { id: key, page }, 'Page draft saved.'); }}>
      <div className="admin-card-head"><div><p className="admin-kicker">PAGE DRAFT</p><h2>{key === 'home' ? 'Home page' : key}</h2></div>{canPublish && current?.hasDraft && <button type="button" className="admin-secondary" disabled={busy} onClick={() => onAction('content', 'publish', { id: key }, 'Page published.')}>Publish current draft</button>}</div>
      {key === 'home' ? <div className="admin-home-editor"><Field label="Hero product selection"><div className="admin-choice-grid">{products.map(product => <label key={product.slug}><input type="checkbox" checked={(page.heroProductSlugs || []).includes(product.slug)} onChange={event => setField('heroProductSlugs', event.target.checked ? [...(page.heroProductSlugs || []), product.slug] : (page.heroProductSlugs || []).filter(slug => slug !== product.slug))} />{product.name}</label>)}</div></Field>
        <HomeListEditor label="Metrics" rows={page.metrics} fields={[["value", "Value"], ["label", "Label"], ["detail", "Detail"]]} onChange={value => setField('metrics', value)} />
        <HomeListEditor label="Partners" rows={page.partners} fields={[["name", "Name"], ["logo", "Logo URL"]]} onChange={value => setField('partners', value)} />
        <HomeListEditor label="Testimonials" rows={page.testimonials} fields={[["quote", "Quote"], ["name", "Name"], ["role", "Role"], ["avatar", "Avatar URL"]]} onChange={value => setField('testimonials', value)} />
      </div> : <div className="admin-form-grid"><Field label="Title"><TextInput value={page.title} onChange={value => setField('title', value)} /></Field><Field label="SEO title"><TextInput value={page.seo?.title} onChange={value => setField('seo', { ...page.seo, title: value })} /></Field><Field label="SEO description"><textarea value={page.seo?.description || ''} onChange={event => setField('seo', { ...page.seo, description: event.target.value })} /></Field></div>}
      <details className="admin-json" onToggle={event => { if (event.currentTarget.open) setAdvanced(JSON.stringify(page, null, 2)); }}><summary>Advanced page JSON</summary><p>Edit page sections and additional fields as JSON, then apply before saving.</p><textarea value={advanced} onChange={event => setAdvanced(event.target.value)} rows={12} spellCheck={false} /><button type="button" className="admin-secondary" onClick={applyJson}>Apply JSON</button>{jsonError && <p role="alert">{jsonError}</p>}</details>
      <div className="admin-form-actions"><button className="admin-primary" disabled={busy}>Save draft</button></div>
    </form>}
  </>;
}

function PromotionsPanel({ items, onAction, busy }) {
  const [form, setForm] = useState({ code: '', kind: 'percent', value: '', maxUses: 100, startAt: '', endAt: '', eligibleSkus: '', active: false });
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  function edit(item) { setForm({ ...item, value: item.kind === 'percent' ? item.value / 100 : item.value / 100, startAt: item.startAt?.slice(0, 16) || '', endAt: item.endAt?.slice(0, 16) || '', eligibleSkus: (item.eligibleSkus || []).join(', ') }); }
  return <><section className="admin-card admin-catalog"><div className="admin-card-head"><div><p className="admin-kicker">PROMOTIONS</p><h2>Discount codes</h2></div></div><div className="admin-table-scroll"><table><thead><tr><th>Code</th><th>Value</th><th>Usage</th><th>Period</th><th>Status</th><th></th></tr></thead><tbody>{items.map(item => <tr key={item.code || item.id}><td><strong>{item.code || item.id}</strong></td><td>{item.kind === 'percent' ? `${item.value / 100}%` : money(item.value / 100)}</td><td>{item.usedCount || 0} / {item.maxUses}</td><td>{item.startAt?.slice(0, 10)} – {item.endAt?.slice(0, 10)}</td><td>{item.active ? 'Active' : 'Paused'}</td><td><button className="admin-secondary" onClick={() => edit(item)}>Edit</button></td></tr>)}</tbody></table></div>{!items.length && <p className="admin-empty">No promotion codes yet.</p>}</section>
    <form className="admin-card admin-editor" onSubmit={event => { event.preventDefault(); onAction('promotions', 'save', { item: { code: form.code, kind: form.kind, value: Math.round(Number(form.value) * 100), maxUses: Number(form.maxUses), startAt: new Date(form.startAt).toISOString(), endAt: new Date(form.endAt).toISOString(), eligibleSkus: parseList(form.eligibleSkus), active: form.active } }, 'Promotion saved.'); }}><div className="admin-card-head"><div><p className="admin-kicker">CODE SETTINGS</p><h2>Create or edit a promotion</h2></div></div><div className="admin-form-grid">
      <Field label="Code"><TextInput value={form.code} onChange={value => set('code', value.toUpperCase())} required pattern="[A-Z0-9_-]{3,32}" /></Field>
      <Field label="Discount type"><select value={form.kind} onChange={event => set('kind', event.target.value)}><option value="percent">Percent off</option><option value="fixed">Fixed ₹ off</option></select></Field>
      <Field label={form.kind === 'percent' ? 'Percent off' : 'Amount in ₹'}><TextInput type="number" min="0.01" max={form.kind === 'percent' ? '100' : undefined} step="0.01" value={form.value} onChange={value => set('value', value)} required /></Field>
      <Field label="Maximum uses (0 = unlimited)"><TextInput type="number" min="0" step="1" value={form.maxUses} onChange={value => set('maxUses', value)} required /></Field>
      <Field label="Starts"><TextInput type="datetime-local" value={form.startAt} onChange={value => set('startAt', value)} required /></Field>
      <Field label="Ends"><TextInput type="datetime-local" value={form.endAt} onChange={value => set('endAt', value)} required /></Field>
      <Field label="Eligible SKUs (blank means all)"><TextInput value={form.eligibleSkus} onChange={value => set('eligibleSkus', value)} /></Field>
      <Field label="Availability"><label><input type="checkbox" checked={form.active} onChange={event => set('active', event.target.checked)} /> Active</label></Field>
    </div><div className="admin-form-actions"><button className="admin-primary" disabled={busy}>Save promotion</button></div></form>
  </>;
}

function StaffPanel({ items, onAction, busy }) {
  const [uid, setUid] = useState('');
  const [roles, setRoles] = useState([]);
  return <><section className="admin-card admin-catalog"><div className="admin-card-head"><div><p className="admin-kicker">ACCESS CONTROL</p><h2>Staff roles</h2></div></div><div className="admin-table-scroll"><table><thead><tr><th>Firebase UID</th><th>Roles</th><th>Access</th><th></th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><strong>{item.id}</strong></td><td>{(item.roles || []).join(', ') || '—'}</td><td>{item.active === false ? 'Revoked' : 'Active'}</td><td><button className="admin-secondary" onClick={() => { setUid(item.id); setRoles(item.roles || []); }}>Edit</button></td></tr>)}</tbody></table></div>{!items.length && <p className="admin-empty">No staff grants yet. The owner UID can be bootstrapped in server settings.</p>}</section>
    <form className="admin-card admin-editor" onSubmit={event => { event.preventDefault(); onAction('staff', 'grant', { uid: uid.trim(), roles }, 'Staff roles saved.'); }}><div className="admin-card-head"><div><p className="admin-kicker">GRANT ACCESS</p><h2>Assign staff roles</h2></div></div><div className="admin-form-grid"><Field label="Firebase user UID"><TextInput value={uid} onChange={setUid} minLength={8} required /></Field><Field label="Roles"><div className="admin-choice-grid">{roleOptions.map(role => <label key={role}><input type="checkbox" checked={roles.includes(role)} onChange={event => setRoles(current => event.target.checked ? [...current, role] : current.filter(value => value !== role))} />{role}</label>)}</div></Field></div><p className="admin-form-note">Use a Firebase UID from an existing account. Role changes are audited.</p><div className="admin-form-actions"><button className="admin-primary" disabled={busy || !uid || !roles.length}>Grant roles</button><button type="button" className="admin-secondary" disabled={busy || !uid} onClick={() => onAction('staff', 'revoke', { uid: uid.trim() }, 'Staff access revoked.')}>Revoke access</button></div></form>
  </>;
}

function SettingsPanel({ item, onAction, busy, canWrite }) {
  const [form, setForm] = useState({ originState: '', pickupPincode: '', gstin: '', shippingGstRateBps: '', shippingMarkupPaise: 0, shiprocketPickupLocation: '', pickupAddress: { line1: '', line2: '', city: '', state: '', pincode: '' }, ...item });
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const setAddress = (key, value) => setForm(current => ({ ...current, pickupAddress: { ...current.pickupAddress, [key]: value } }));
  return <form className="admin-card admin-editor" onSubmit={event => { event.preventDefault(); onAction('settings', 'save', { item: { originState: form.originState, pickupPincode: form.pickupPincode, gstin: form.gstin, shippingGstRateBps: Number(form.shippingGstRateBps), shippingMarkupPaise: Number(form.shippingMarkupPaise || 0), shiprocketPickupLocation: form.shiprocketPickupLocation, pickupAddress: form.pickupAddress } }, 'Store settings saved.'); }}><div className="admin-card-head"><div><p className="admin-kicker">COMMERCE SETTINGS</p><h2>Tax and shipping origin</h2></div></div><div className="admin-form-grid">
    <Field label="GSTIN"><TextInput value={form.gstin} onChange={value => set('gstin', value.toUpperCase())} maxLength={15} required disabled={!canWrite} /></Field>
    <Field label="Pickup state"><TextInput value={form.originState} onChange={value => set('originState', value)} required disabled={!canWrite} /></Field>
    <Field label="Pickup PIN code"><TextInput value={form.pickupPincode} onChange={value => set('pickupPincode', value)} pattern="[0-9]{6}" required disabled={!canWrite} /></Field>
    <Field label="Shipping GST rate (basis points)"><TextInput type="number" min="0" max="10000" step="1" value={form.shippingGstRateBps} onChange={value => set('shippingGstRateBps', value)} required disabled={!canWrite} /></Field>
    <Field label="Shipping markup (paise)"><TextInput type="number" min="0" max="2000000" step="1" value={form.shippingMarkupPaise} onChange={value => set('shippingMarkupPaise', value)} disabled={!canWrite} /></Field>
    <Field label="Shiprocket pickup location"><TextInput value={form.shiprocketPickupLocation} onChange={value => set('shiprocketPickupLocation', value)} disabled={!canWrite} /></Field>
    {['line1', 'line2', 'city', 'state', 'pincode'].map(key => <Field key={key} label={`Pickup address ${key}`}><TextInput value={form.pickupAddress?.[key]} onChange={value => setAddress(key, value)} disabled={!canWrite} /></Field>)}
  </div>{canWrite && <div className="admin-form-actions"><button className="admin-primary" disabled={busy}>Save settings</button></div>}</form>;
}

export default function AdminPanel() {
  const { status, user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState({});
  const [ordersData, setOrdersData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editingProduct, setEditingProduct] = useState(null);
  const can = permission => canAccess(user, permission);
  const tabs = useMemo(() => [
    ['overview', 'Overview', LayoutDashboard, true],
    ['products', 'Products', Package, can('catalog.read')],
    ['inventory', 'Inventory', Truck, can('inventory.read')],
    ['content', 'Content', FileText, can('content.read')],
    ['promotions', 'Promotions', Tags, can('promotions.manage')],
    ['staff', 'Staff', Users, can('staff.manage')],
    ['settings', 'Settings', SlidersHorizontal, can('settings.read')],
  ].filter(([, , , allowed]) => allowed), [user]);
  const resource = tab === 'overview' ? (can('catalog.read') ? 'products' : null) : tab;
  useEffect(() => {
    if (!resource) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    adminRead(resource, controller.signal)
      .then(data => { if (!controller.signal.aborted) setRecords(current => ({ ...current, [resource]: data })); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [resource, revision, user?.id]);
  useEffect(() => {
    if (tab !== 'overview' || !canAccess(user, 'orders.read')) return;
    const controller = new AbortController();
    orderRequest({ staff: '1' }, undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setOrdersData(data); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [tab, revision, user?.id, user?.permissions]);
  async function act(resourceName, action, payload, success) {
    setBusy(true); setError(''); setMessage('');
    try { await adminWrite(resourceName, action, payload); setMessage(success); setRevision(value => value + 1); return true; }
    catch (failure) { setError(failure.message); return false; }
    finally { setBusy(false); }
  }
  async function upload(file) {
    if (file.size > 5 * 1024 * 1024) { setError('Use an image smaller than 5 MB.'); return ''; }
    setBusy(true); setError('');
    try {
      const dataBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Image could not be read.')); reader.readAsDataURL(file); });
      const result = await adminWrite('media', 'upload', { name: file.name, type: file.type, dataBase64 });
      setMessage('Image uploaded. Save the product draft to use it.');
      return result.media.url;
    } catch (failure) { setError(failure.message); return ''; }
    finally { setBusy(false); }
  }
  if (status === 'loading') return <main className="admin-loading">Checking your staff account…</main>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.roles?.length) return <main className="admin-denied">Staff access required</main>;
  const items = records[resource]?.items || [];
  const products = records.products?.items || [];
  const orders = ordersData?.orders || [];
  const visibleProducts = products.filter(product => `${product.name} ${product.category} ${product.sku}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="admin-page">
    <aside className="admin-sidebar">
      <Link to="/dashboard" className="admin-brand"><span className="admin-logo">S</span><span>SPARK-DV<small>COMMERCE ADMIN</small></span></Link>
      <p className="admin-nav-label">WORKSPACE</p>
      <nav aria-label="Admin navigation">{tabs.map(([id, label, Icon]) => <button type="button" className={tab === id ? 'active' : ''} key={id} onClick={() => { setTab(id); setError(''); setMessage(''); setEditingProduct(null); }}><Icon size={18}/>{label}</button>)}{can('orders.read') && <Link to="/manage/orders"><ClipboardList size={18}/>Orders</Link>}<a href={storefront} target="_blank" rel="noreferrer"><ArrowUpRight size={18}/>View storefront</a></nav>
      <div className="admin-sidebar-note"><ShieldCheck size={21}/><strong>Managed storefront</strong><p>Drafts, publishing and stock changes are saved to the commerce database.</p></div>
      <div className="admin-sidebar-footer"><span className="admin-avatar">{(user.name || 'S')[0]}</span><div><strong>{user.name || 'Staff member'}</strong><small>{(user.roles || []).join(', ')}</small></div></div>
    </aside>
    <section className="admin-content">
      <header className="admin-topbar"><div><p className="admin-kicker">WORKSPACE / {tab.toUpperCase()}</p><h1>{tabs.find(([id]) => id === tab)?.[1] || 'Overview'}</h1><p className="admin-muted">Manage the SPARK-DV storefront from this workspace.</p></div><button className="admin-refresh" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16}/>{loading ? 'Refreshing…' : 'Refresh'}</button></header>
      {error && <p className="admin-error" role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
      {message && <p className="admin-success" role="status">{message}</p>}
      {tab === 'overview' && <>
        <section className="admin-stats"><article className="admin-stat"><div><span>Published products</span><Package size={19}/></div><strong>{can('catalog.read') ? products.filter(product => product.publishedVersion && product.status !== 'archived').length : '—'}</strong><small>Live on the storefront</small></article><article className="admin-stat"><div><span>Product drafts</span><FileText size={19}/></div><strong>{can('catalog.read') ? products.filter(product => product.hasDraft).length : '—'}</strong><small>Waiting for review</small></article><article className="admin-stat"><div><span>Recent orders</span><ClipboardList size={19}/></div><strong>{can('orders.read') ? orders.length : '—'}</strong><small>{can('orders.read') ? 'Loaded order page' : 'Requires order access'}</small></article><article className="admin-stat"><div><span>In fulfillment</span><Truck size={19}/></div><strong>{can('orders.read') ? orders.filter(order => ['paid', 'confirmed', 'dispatched', 'out_for_delivery'].includes(order.status)).length : '—'}</strong><small>Current loaded orders</small></article></section>
        {can('orders.read') && <section className="admin-card admin-catalog"><div className="admin-card-head"><div><p className="admin-kicker">ORDER ACTIVITY</p><h2>Recent orders</h2></div><Link to="/manage/orders">View all <ArrowUpRight size={16}/></Link></div>{orders.length ? orders.slice(0, 5).map(order => <Link className="admin-order-row" key={order.id} to={`/manage/orders/${order.id}`}><span className="admin-order-mark"><ClipboardList size={18}/></span><div><strong>{orderReference(order.id)}</strong><p>{order.customer?.name || 'Customer'} · {order.items?.length || 0} items</p></div><div className="admin-order-end"><strong>{money(order.totalPaise != null ? order.totalPaise / 100 : order.subtotal)}</strong><span className={`admin-status ${order.status}`}>{orderCheckpoints[order.status]?.label || order.status}</span></div></Link>) : <p className="admin-empty">No orders in the loaded page.</p>}</section>}
      </>}
      {(tab === 'overview' || tab === 'products') && can('catalog.read') && <><section className="admin-card admin-catalog"><div className="admin-card-head"><div><p className="admin-kicker">STOREFRONT CATALOG</p><h2>{tab === 'overview' ? 'Products at a glance' : 'Product drafts and listings'} <small>{products.length}</small></h2></div><div className="admin-head-actions"><label className="admin-search"><Search size={17}/><input aria-label="Search products" placeholder="Search products…" value={query} onChange={event => setQuery(event.target.value)}/></label>{tab === 'products' && can('catalog.write') && <button className="admin-primary" onClick={() => setEditingProduct({})}>New product</button>}</div></div><div className="admin-table-scroll"><table><thead><tr><th>Product</th><th>SKU</th><th>Category</th><th>Price</th><th>Status</th><th>Actions</th></tr></thead><tbody>{visibleProducts.slice(0, tab === 'overview' && !query ? 5 : undefined).map(product => <tr key={product.id || product.slug}><td><strong>{product.name}</strong><small>{product.variant || product.slug}</small></td><td>{product.sku || '—'}</td><td>{product.category || '—'}</td><td>{money(product.price)}</td><td><span className={`admin-status ${product.hasDraft ? 'pending' : 'confirmed'}`}>{product.hasDraft ? product.publishedVersion ? 'Draft + live' : 'Draft' : product.status === 'archived' ? 'Archived' : 'Published'}</span></td><td><div className="admin-row-actions">{tab === 'products' && can('catalog.write') && <button className="admin-secondary" onClick={() => setEditingProduct(product)}>Edit</button>}{tab === 'products' && product.hasDraft && can('catalog.publish') && <button className="admin-secondary" disabled={busy} onClick={() => act('products', 'publish', { id: product.slug || product.id }, 'Product published.')}>Publish</button>}{tab === 'products' && product.publishedVersion && product.status !== 'archived' && can('catalog.publish') && <button className="admin-secondary" disabled={busy} onClick={() => act('products', 'archive', { id: product.slug || product.id }, 'Product archived.')}>Archive</button>}{product.publishedVersion && <a href={`${storefront}/products/${product.slug || product.id}`} target="_blank" rel="noreferrer" aria-label={`View ${product.name}`}><ArrowUpRight size={18}/></a>}</div></td></tr>)}</tbody></table></div>{!visibleProducts.length && <p className="admin-empty">{loading ? 'Loading products…' : products.length ? `No products match “${query}”.` : 'No products yet. Create a draft to start the catalog.'}</p>}{tab === 'overview' && products.length > 5 && <button className="admin-catalog-more" onClick={() => setTab('products')}>Manage products <ArrowUpRight size={15}/></button>}</section>{tab === 'products' && editingProduct !== null && can('catalog.write') && <ProductEditor key={editingProduct.slug || 'new'} product={editingProduct} busy={busy} onUpload={upload} onCancel={() => setEditingProduct(null)} onSave={item => act('products', 'saveDraft', { item }, 'Product draft saved.')} />}</>}
      {resource && loading && !records[resource] && <p className="admin-empty" role="status">Loading {resource}…</p>}
      {tab === 'inventory' && records.inventory && <InventoryPanel items={items} canAdjust={can('inventory.adjust')} onAction={act} busy={busy} />}
      {tab === 'content' && records.content && <ContentPanel items={items} products={products.filter(product => product.publishedVersion && product.status !== 'archived')} canWrite={can('content.write')} canPublish={can('content.publish')} onAction={act} busy={busy} />}
      {tab === 'promotions' && records.promotions && <PromotionsPanel items={items} onAction={act} busy={busy} />}
      {tab === 'staff' && records.staff && <StaffPanel items={items} onAction={act} busy={busy} />}
      {tab === 'settings' && records.settings && <SettingsPanel key={revision} item={records.settings.item || {}} onAction={act} busy={busy} canWrite={can('settings.write')} />}
      <footer className="admin-footer">SPARK-DV · Commerce workspace <span>Changes are saved and audited on the server.</span></footer>
    </section>
  </main>;
}
