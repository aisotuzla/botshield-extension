/**
 * BotShield - lib/ip.js
 * 
 * CIDR-less IP Utilities
 * 
 * Architecture Note:
 * All IP resolution, ASN lookups, and MaxMind GeoLite2 database lookups
 * are strictly executed on the backend server. The extension never inspects,
 * collects, or transmits the client's IP address (privacy rule non-negotiable).
 * 
 * This utility module provides lightweight, CIDR-less format validation
 * and sanitization routines for server-provided telemetry signals.
 */

/**
 * Checks if a given string matches standard IPv4 dotted-decimal notation.
 * Does not accept CIDR notation (backend handles subnet calculations).
 * 
 * @param {string} str - Candidate IP string
 * @returns {boolean}
 */
export function isIPv4(str) {
  if (typeof str !== 'string') return false;
  const parts = str.trim().split('.');
  if (parts.length !== 4) return false;
  
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number(part);
    if (num < 0 || num > 255) return false;
    if (part.length > 1 && part.startsWith('0')) return false; // Prevent octal leading zeros
  }
  return true;
}

/**
 * Checks if a given string matches standard IPv6 notation.
 * 
 * @param {string} str - Candidate IP string
 * @returns {boolean}
 */
export function isIPv6(str) {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  // Standard IPv6 regex supporting compressed :: syntax
  const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
  return ipv6Regex.test(trimmed);
}

/**
 * Checks if a string is a valid IPv4 or IPv6 address.
 * 
 * @param {string} str 
 * @returns {boolean}
 */
export function isIP(str) {
  return isIPv4(str) || isIPv6(str);
}

/**
 * Strips CIDR notation, port numbers, or protocol prefixes from an IP string.
 * Ensures the extension handles clean host identifiers without performing CIDR logic.
 * 
 * @param {string} ipWithPotentialCidr 
 * @returns {string}
 */
export function sanitizeIP(ipWithPotentialCidr) {
  if (typeof ipWithPotentialCidr !== 'string') return '';
  let sanitized = ipWithPotentialCidr.trim();
  // Strip CIDR prefix length (e.g., /24, /64)
  if (sanitized.includes('/')) {
    sanitized = sanitized.split('/')[0];
  }
  // Strip IPv4 port (e.g., :8080)
  if (sanitized.includes(':') && !sanitized.includes('::') && sanitized.split('.').length === 4) {
    sanitized = sanitized.split(':')[0];
  }
  return sanitized.trim();
}

/**
 * Anonymizes an IP for logging or display purposes (e.g. 192.168.1.xxx or 2001:db8::xxxx)
 * 
 * @param {string} ip 
 * @returns {string}
 */
export function maskIP(ip) {
  const clean = sanitizeIP(ip);
  if (isIPv4(clean)) {
    const parts = clean.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }
  if (isIPv6(clean)) {
    const parts = clean.split(':');
    return `${parts.slice(0, 3).join(':')}::xxxx`;
  }
  return 'masked';
}
