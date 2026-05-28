export const CURRENT_USER_KEY = "guided-claude-current-user";
export const LEGACY_SESSION_KEY = "guided-claude-chat-sessions";
export const USER_SESSION_PREFIX = "guided-claude-chat-sessions:";

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export function userNameFromEmail(email) {
  const prefix = String(email || "").split("@")[0].trim();
  return prefix || "User";
}

export function userSessionKey(email) {
  return `${USER_SESSION_PREFIX}${normalizeEmail(email)}`;
}

export function loadCurrentUser() {
  try {
    return String(localStorage.getItem(CURRENT_USER_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function saveCurrentUser(email) {
  try {
    localStorage.setItem(CURRENT_USER_KEY, String(email || "").trim());
  } catch {
    // Local storage can be unavailable in private or embedded contexts.
  }
}

export function clearCurrentUser() {
  try {
    localStorage.removeItem(CURRENT_USER_KEY);
  } catch {
    // Local storage can be unavailable in private or embedded contexts.
  }
}

export function clearLegacySharedHistory() {
  try {
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // Local storage can be unavailable in private or embedded contexts.
  }
}

export function loadSessionsForUser(email) {
  try {
    const stored = JSON.parse(localStorage.getItem(userSessionKey(email)) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

export function saveSessionsForUser(email, sessions) {
  try {
    localStorage.setItem(userSessionKey(email), JSON.stringify(Array.isArray(sessions) ? sessions : []));
  } catch {
    // Local storage can be unavailable in private or embedded contexts.
  }
}
