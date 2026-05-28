export function groupSessionsForSidebar(sessions) {
  const groups = new Map();
  for (const session of sessions || []) {
    const key = session.groupId || session.id;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(session);
  }

  return [...groups.entries()]
    .map(([groupId, items]) => ({
      groupId,
      sessions: sortGroupSessions(items),
      updatedAt: items.reduce((latest, item) => Math.max(latest, new Date(item.updatedAt || 0).getTime()), 0)
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function removeSessionById(sessions, sessionId) {
  return (sessions || []).filter((session) => session.id !== sessionId);
}

function sortGroupSessions(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map();
  const roots = [];

  for (const item of items) {
    if (item.parentId && byId.has(item.parentId)) {
      if (!children.has(item.parentId)) {
        children.set(item.parentId, []);
      }
      children.get(item.parentId).push(item);
    } else {
      roots.push(item);
    }
  }

  const byCreated = (left, right) => new Date(left.createdAt || left.updatedAt || 0) - new Date(right.createdAt || right.updatedAt || 0);
  roots.sort(byCreated);
  children.forEach((list) => list.sort(byCreated));

  const ordered = [];
  const visit = (item) => {
    ordered.push(item);
    (children.get(item.id) || []).forEach(visit);
  };
  roots.forEach(visit);

  return ordered.length === items.length ? ordered : [...items].sort(byCreated);
}
