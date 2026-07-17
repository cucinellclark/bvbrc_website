define([], function() {
  // Matches common BV-BRC workspace absolute paths.
  // Supports account-rooted paths (/user@domain/...),
  // and shared roots like /home, /workspace, /scratch.
  var WORKSPACE_PATH_REGEX = /\/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~:@%+,\-=]+)+|\/(?:home|workspace|scratch)(?:\/[A-Za-z0-9._~:@%+,\-=]+)+/g;
  var TRAILING_PUNCTUATION_REGEX = /[.,;:!?)]$/;

  function trimTrailingPunctuation(token) {
    var text = token || '';
    while (text && TRAILING_PUNCTUATION_REGEX.test(text)) {
      text = text.slice(0, -1);
    }
    return text;
  }

  function findPathMatches(text) {
    if (typeof text !== 'string' || !text.length) {
      return [];
    }

    var matches = [];
    WORKSPACE_PATH_REGEX.lastIndex = 0;
    var result;
    while ((result = WORKSPACE_PATH_REGEX.exec(text)) !== null) {
      var rawMatch = result[0];
      var normalized = trimTrailingPunctuation(rawMatch);
      if (!normalized) {
        continue;
      }
      matches.push({
        path: normalized,
        start: result.index,
        end: result.index + normalized.length
      });
    }
    return matches;
  }

  function toWorkspaceBrowserUrl(path) {
    if (!path || typeof path !== 'string') {
      return null;
    }
    var normalizedPath = path.charAt(0) === '/' ? path : '/' + path;
    return '/workspace' + normalizedPath;
  }

  return {
    findPathMatches: findPathMatches,
    toWorkspaceBrowserUrl: toWorkspaceBrowserUrl
  };
});
