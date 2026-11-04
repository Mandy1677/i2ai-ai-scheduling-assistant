// Classification references from docs/PRD.md section 3. These become
// non-identifying role hints during redaction; the directory itself is never
// sent to the model. Mappings the client has not confirmed stay generic.

export type ContactRole =
  | 'thriveworks-pr-contact'
  | 'interactive-foundation-contact'
  | 'important-contact'
  | 'thriveworks-sender'
  | 'pennwest-sender'
  | 'educational-sender';

export const ROLE_LABELS: Record<ContactRole, string> = {
  'thriveworks-pr-contact': 'Jennifer / Thriveworks PR contact',
  'interactive-foundation-contact': 'Interactive Foundation contact',
  'important-contact': 'important contact (category not supplied)',
  'thriveworks-sender': 'sender from the Thriveworks domain (not necessarily PR)',
  'pennwest-sender': 'sender from the PennWest University domain',
  'educational-sender': 'sender from an educational (.edu) domain',
};

/** Exact addresses with a supplied role. */
const KNOWN_ADDRESSES: Record<string, ContactRole> = {
  'jenm@thriveworks.com': 'thriveworks-pr-contact',
  'jes@interactivityfoundation.org': 'interactive-foundation-contact',
  'jessica.friedrichs@gmail.com': 'important-contact',
  'ysalib47@gmail.com': 'important-contact',
  'azadeh.chec@gmail.com': 'important-contact',
};

/** Names that identify a known contact in message text. */
export const KNOWN_CONTACT_NAMES: { pattern: RegExp; role: ContactRole }[] = [
  { pattern: /\bJennifer(?:\s+Bagnall)?\b/g, role: 'thriveworks-pr-contact' },
];

/** The clinician's own addresses and names; replaced with a role, not an alias. */
export const CLINICIAN_ADDRESSES = new Set([
  'cwynarmr2@upmc.edu',
  'skippycwynar@comcast.net',
  'monicac.chec@gmail.com',
  'monica.cwynar@thriveworks.com',
]);
export const CLINICIAN_NAME_PATTERN = /\b(?:Monica(?:\s+R\.?)?(?:\s+Cwynar)?|(?:Dr\.?|Professor|Prof\.?|Ms\.?|Mrs\.?)\s+Cwynar|Cwynar)\b/gi;

/** Role hint for a sender address, or null when nothing is known. */
export function roleForAddress(address: string): ContactRole | null {
  const lower = address.toLowerCase();
  const known = KNOWN_ADDRESSES[lower];
  if (known) return known;
  const domain = lower.split('@')[1] ?? '';
  if (domain === 'thriveworks.com') return 'thriveworks-sender';
  if (domain === 'pennwest.edu' || domain.endsWith('.pennwest.edu')) return 'pennwest-sender';
  if (domain.endsWith('.edu')) return 'educational-sender';
  return null;
}
