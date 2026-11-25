// The deployed build selects its surface. Hostname is only a local development fallback;
// server-side permissions are always checked independently.
const surface = import.meta.env.VITE_APP_SURFACE;
export const isStaffSurface = surface === 'staff' || (surface !== 'store' && (
  window.location.hostname === 'app.sparkdv.com' || window.location.hostname === 'app.localhost'
));
