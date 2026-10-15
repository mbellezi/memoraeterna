/**
 * Which lens the Wiki's reading surface shows: the open topic (or where to start), or the Map of
 * the whole tree. The rules for when the lens changes by itself live here, outside React.
 */
export type WikiLens = "topic" | "map";

/** A topic that is opened, from the Map, the tree or a link, shows in the Topic lens. */
export function lensAfterNavigation(lens: WikiLens, navigation: { type: string }): WikiLens {
  return navigation.type === "topic" ? "topic" : lens;
}

/**
 * The topic shown changed (Back, Forward or a link from another view): the Topic lens shows it.
 * Opening the same topic again changes no topic id, so `lensAfterNavigation` covers that case.
 */
export function lensAfterTopicChange(
  lens: WikiLens,
  previousTopicId: string | null,
  topicId: string | null
): WikiLens {
  return previousTopicId === topicId ? lens : "topic";
}
