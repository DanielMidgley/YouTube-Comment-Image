const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for use in HTML content and double-quoted attribute values. */
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ENTITIES[char]);
