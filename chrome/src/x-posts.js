(() => {
  "use strict";

  // Retain the file for unpacked extensions whose cached manifest still lists it.
  // Post selection is bundled in content.js so missing this script cannot stop the extension.
  if (typeof module !== "undefined" && module.exports) module.exports = require("./content.js");
})();
