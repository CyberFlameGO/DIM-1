import { Search } from '@destinyitemmanager/dim-api-types';
import { t } from 'app/i18next-t';
import { chainComparator, compareBy, reverseComparator } from 'app/utils/comparators';
import { uniqBy } from 'app/utils/util';
import _ from 'lodash';
import memoizeOne from 'memoize-one';
import { SearchConfig } from './search-config';
import freeformFilters from './search-filters/freeform';

/** The autocompleter/dropdown will suggest different types of searches */
export const enum SearchItemType {
  /** Searches from your history */
  Recent,
  /** Explicitly saved searches */
  Saved,
  /** Searches suggested by DIM Sync but not part of your history */
  Suggested,
  /** Generated autocomplete searches */
  Autocomplete,
  /** Open help */
  Help,
  // TODO: add types for exact-match item or perk that adds them to the query?
}

/** An item in the search autocompleter */
export interface SearchItem {
  type: SearchItemType;
  /** The suggested query */
  query: string;
  /** An optional part of the query that will be highlighted */
  highlightRange?: [number, number];
  /** Help text */
  helpText?: React.ReactNode;
}

/** matches a keyword that's probably a math comparison */
const mathCheck = /[\d<>=]/;

/** if one of these has been typed, stop guessing which filter and just offer this filter's values */
// TODO: Generate this from the search config
const filterNames = [
  'is',
  'not',
  'tag',
  'notes',
  'stat',
  'stack',
  'count',
  'source',
  'perk',
  'perkname',
  'mod',
  'modname',
  'name',
  'description',
];

/**
 * Produce a memoized autocompleter function that takes search text plus a list of recent/saved searches
 * and produces the contents of the autocomplete list.
 */
export default function createAutocompleter(searchConfig: SearchConfig) {
  const filterComplete = makeFilterComplete(searchConfig);

  return memoizeOne((query: string, caretIndex: number, recentSearches: Search[]): SearchItem[] => {
    // If there's a query, it's always the first entry
    const queryItem = query
      ? {
          type: SearchItemType.Autocomplete,
          query: query,
        }
      : undefined;
    // Generate completions of the current search
    const filterSuggestions = autocompleteTermSuggestions(
      query,
      caretIndex,
      filterComplete,
      searchConfig
    );

    // Recent/saved searches
    const recentSearchItems = filterSortRecentSearches(query, recentSearches);

    // Help is always last...
    // Add an item for opening the filter help
    const helpItem = {
      type: SearchItemType.Help,
      query: query || '', // use query as the text so we don't change text when selecting it
    };

    // mix them together
    return [
      ..._.take(
        uniqBy(_.compact([queryItem, ...filterSuggestions, ...recentSearchItems]), (i) => i.query),
        7
      ),
      helpItem,
    ];
  });
}

// TODO: this should probably be different when there's a query vs not. With a query
// it should sort on how closely you match, while without a query it's just offering
// you your "favorite" searches.
export const recentSearchComparator = reverseComparator(
  chainComparator<Search>(
    // Saved searches before recents
    compareBy((s) => s.saved),
    compareBy((s) => frecency(s.usageCount, s.lastUsage))
  )
);

/**
 * "Frecency" combines frequency and recency to form a ranking score from [0,1].
 * Note that our usages aren't individually tracked, so they never expire.
 */
function frecency(usageCount: number, lastUsedTimestampMillis: number) {
  // We just multiply them together with equal weight, but we may want to weight them differently in the future.
  return normalizeUsage(usageCount) * normalizeRecency(lastUsedTimestampMillis);
}

/**
 * A sigmoid normalization function that normalizes usages to [0,1]. After 10 uses it's all the same.
 * https://www.desmos.com/calculator/fxi9thkuft
 */
//
function normalizeUsage(val: number) {
  const z = 0.4;
  const k = 0.5;
  const t = 0.9;
  return (1 + t) / (1 + Math.exp(-k * (val - z))) - t;
}

/**
 * An exponential decay score based on the age of the last usage.
 * https://www.desmos.com/calculator/3jfqccibdn
 */
//
function normalizeRecency(timestamp: number) {
  const days = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
  const halfLife = 14; // two weeks
  return Math.pow(2, -days / halfLife);
}

export function filterSortRecentSearches(query: string, recentSearches: Search[]): SearchItem[] {
  // Recent/saved searches
  // TODO: Filter recent searches by query
  // TODO: Sort recent searches by relevance (time+usage+saved)
  // TODO: don't show results that exactly match the input
  // TODO: need a better way to search recent queries
  // TODO: if there are a ton of recent/saved searches, this sorting might get expensive. Maybe sort them in the Redux store if
  //       we aren't going to do different sorts for query vs. non-query
  const recentSearchesForQuery = query
    ? recentSearches.filter((s) => s.query.includes(query))
    : Array.from(recentSearches);
  return recentSearchesForQuery.sort(recentSearchComparator).map((s) => ({
    type: s.saved
      ? SearchItemType.Saved
      : s.usageCount > 0
      ? SearchItemType.Recent
      : SearchItemType.Suggested,
    query: s.query,
  }));
}

const caretEndRegex = /([\s)]|$)/;

// most times, insist on at least 3 typed characters, but for #, start suggesting immediately
const lastWordRegex = /(\b[\w:"'<=>]{3,}|#\w*)$/;
// matches a string that seems to end with a closing, not opening, quote
const closingQuoteRegex = /\w["']$/;

/**
 * Given a query and a cursor position, isolate the term that's being typed and offer reformulated queries
 * that replace that term with one from our filterComplete function.
 */
export function autocompleteTermSuggestions(
  query: string,
  caretIndex: number,
  filterComplete: (term: string) => string[],
  searchConfig: SearchConfig
): SearchItem[] {
  if (!query) {
    return [];
  }

  // Seek to the end of the current part
  caretIndex = (caretEndRegex.exec(query.slice(caretIndex))?.index || 0) + caretIndex;

  // Find the last word that looks like a search
  const match = lastWordRegex.exec(query.slice(0, caretIndex));
  if (!match) {
    return [];
  }
  const term = match[1];
  if (closingQuoteRegex.test(term)) {
    return [];
  }
  const candidates = filterComplete(term);
  const base = query.slice(0, match.index);

  // new query is existing query minus match plus suggestion
  return candidates.map((word) => {
    const filterDef = findFilter(word, searchConfig);
    const newQuery = base + word + query.slice(caretIndex);
    return {
      query: newQuery,
      type: SearchItemType.Autocomplete,
      highlightRange: [match.index, match.index + word.length],
      helpText: filterDef
        ? (Array.isArray(filterDef.description)
            ? t(...filterDef.description)
            : t(filterDef.description)
          )?.replace(/\.$/, '')
        : undefined,
    };
  });
}

function findFilter(term: string, searchConfig: SearchConfig) {
  const parts = term.split(':');
  const filterName = parts[0];
  const filterValue = parts[1];
  // "is:" filters are slightly special cased
  return filterName === 'is'
    ? searchConfig.isFilters[filterValue]
    : searchConfig.kvFilters[filterName];
}

// these filters might include quotes, so we search for two text segments to ignore quotes & colon
// i.e. `name:test` can find `name:"test item"`
const freeformTerms = freeformFilters.flatMap((f) => f.keywords).map((s) => `${s}:`);

/**
 * This builds a filter-complete function that uses the given search config's keywords to
 * offer autocomplete suggestions for a partially typed term.
 */
export function makeFilterComplete(searchConfig: SearchConfig) {
  // TODO: also search filter descriptions
  // TODO: also search individual items from the manifest???
  return (typed: string): string[] => {
    if (!typed) {
      return [];
    }

    let typedToLower = typed.toLowerCase();

    // because we are fighting against other elements for space in the suggestion dropdown,
    // we will entirely skip "not" and "<" and ">" and "<=" and ">=" suggestions,
    // unless the user seems to explicity be working toward them
    const hasNotModifier = typedToLower.startsWith('not');
    const includesAdvancedMath =
      typedToLower.endsWith(':') || typedToLower.endsWith('<') || typedToLower.endsWith('<');
    const filterLowPrioritySuggestions = (s: string) =>
      (hasNotModifier || !s.startsWith('not:')) && (includesAdvancedMath || !/[<>]=?$/.test(s));

    let mustStartWith = '';
    if (freeformTerms.some((t) => typedToLower.startsWith(t))) {
      const typedSegments = typedToLower.split(':');
      mustStartWith = typedSegments.shift()!;
      typedToLower = typedSegments.join(':');
    }

    // for most searches (non-string-based), if there's already a colon typed,
    // we are on a path through known terms, not wildly guessing, so we only match
    // from beginning of the typed string, instead of middle snippets from suggestions.

    // this way, "stat:" matches "stat:" but not "basestat:"
    // and "stat" matches "stat:" and "basestat:"
    const matchType = !mustStartWith && typedToLower.includes(':') ? 'startsWith' : 'includes';

    let suggestions = searchConfig.suggestions
      .filter((word) => word.startsWith(mustStartWith) && word[matchType](typedToLower))
      .filter(filterLowPrioritySuggestions);

    // TODO: sort this first?? it depends on term in one place

    suggestions = suggestions.sort(
      chainComparator(
        // ---------------
        // assumptions based on user behavior. beyond the "contains" filter above, considerations like
        // "the user is probably typing the begining of the filter name, not the middle"
        // ---------------

        // prioritize terms where we are typing the beginning of, ignoring the stem:
        // 'stat' -> 'stat:' before 'basestat:'
        // 'arm' -> 'is:armor' before 'is:sidearm'
        // but only for top level stuff (we want examples like 'basestat:' before 'stat:rpm:')
        compareBy(
          (word) =>
            colonCount(word) > 1
              ? 1 // last if it's a big one like 'stat:rpm:'
              : word.startsWith(typedToLower) ||
                word.indexOf(typedToLower) === word.indexOf(':') + 1
              ? -1 // first if it's a term start or segment start
              : 0 // mid otherwise
        ),

        // for is/not, prioritize words with less left to type,
        // so "is:armor" comes before "is:armormod".
        // but only is/not, not other list-based suggestions,
        // otherwise it prioritizes "dawn" over "redwar" after you type "season:"
        // which i am not into.
        compareBy((word) => {
          if (word.startsWith('not:') || word.startsWith('is:')) {
            return word.length - (typedToLower.length + word.indexOf(typedToLower));
          } else {
            return 0;
          }
        }),

        // ---------------
        // once we have accounted for high level assumptions about user input,
        // make some opinionated choices about which filters are a priority
        // ---------------

        // tags are UGC and therefore important
        compareBy((word) => !word.startsWith('tag:')),

        // sort incomplete terms (ending with ':') to the front
        compareBy((word) => !word.endsWith(':')),

        // push "not" and "<=" and ">=" to the bottom if they are present
        // we discourage "not", and "<=" and ">=" are highly discoverable from "<" and ">"
        compareBy((word) => word.startsWith('not:') || word.endsWith('<=') || word.endsWith('>=')),

        // sort more-basic incomplete terms (fewer colons) to the front
        // i.e. suggest "stat:" before "stat:magazine:"
        compareBy((word) => (word.startsWith('is:') ? 0 : colonCount(word))),

        // (within the math operators that weren't shoved to the far bottom,)
        // push math operators to the front for things like "masterwork:"
        compareBy((word) => !mathCheck.test(word))
      )
    );
    if (filterNames.includes(typedToLower.split(':')[0])) {
      return suggestions;
    } else if (suggestions.length) {
      // we will always add in (later) a suggestion of "what you've already typed so far"
      // so prevent "what's been typed" from appearing in the returned suggestions from this function
      const deDuped = new Set(suggestions);
      deDuped.delete(typed);
      deDuped.delete(typedToLower);
      return [...deDuped];
    }
    return [];
  };
}

function colonCount(s: string) {
  let count = 0;
  for (const c of s) {
    if (c === ':') {
      count++;
    }
  }
  return count;
}
