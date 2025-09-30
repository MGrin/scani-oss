export function prependEntity<T extends { id: string }>(list: T[] | undefined, entity: T): T[] {
  if (!list) {
    return [entity];
  }
  const filtered = list.filter((item) => item.id !== entity.id);
  return [entity, ...filtered];
}

export function replaceEntity<T extends { id: string }>(list: T[] | undefined, entity: T): T[] {
  if (!list) {
    return [entity];
  }
  const index = list.findIndex((item) => item.id === entity.id);
  if (index === -1) {
    return [...list, entity];
  }
  const next = [...list];
  next[index] = entity;
  return next;
}

export function replaceEntityById<T extends { id: string }>(
  list: T[] | undefined,
  id: string,
  entity: T
): T[] {
  if (!list) {
    return [entity];
  }
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) {
    return prependEntity(list, entity);
  }
  const next = [...list];
  next[index] = entity;
  return next;
}

export function removeEntity<T extends { id: string }>(list: T[] | undefined, id: string): T[] {
  if (!list) {
    return [];
  }
  return list.filter((item) => item.id !== id);
}
