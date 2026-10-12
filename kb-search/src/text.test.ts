import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold, stem, tokenize, words } from "./text.ts";

describe("fold", () => {
  it("lowercases, strips accents, drops hyphens", () => {
    assert.equal(fold("Café NAÏVE Smoke-Detector"), "cafe naive smokedetector");
  });
});

describe("stem", () => {
  it("makes inflected forms meet", () => {
    assert.equal(stem("radiator"), stem("radiators"));
    assert.equal(stem("leak"), stem("leaking"));
    assert.equal(stem("service"), stem("serviced"));
    assert.equal(stem("battery"), stem("batteries"));
    assert.equal(stem("owner"), stem("owners"));
  });

  it("never strips a word below the minimum stem length", () => {
    assert.equal(stem("gas"), "gas");
    assert.equal(stem("bus"), "bus");
    assert.equal(stem("keys"), "key");
  });
});

describe("tokenize", () => {
  it("drops stopwords, apostrophes and punctuation", () => {
    assert.deepEqual(words("How do I get my deposit back?"), ["deposit", "back"]);
    assert.deepEqual(words("I can't find the owners' minutes"), ["find", "owners", "minutes"]);
  });

  it("is consistent between document and query forms", () => {
    assert.deepEqual(tokenize("The Radiators"), tokenize("radiator"));
  });

  it("returns nothing for empty or stopword-only input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize("what is this?"), []);
  });
});
