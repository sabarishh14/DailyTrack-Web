// Short, distinct words for a suggested passphrase: 6 of 256 is 48 bits, and
// with 600,000 rounds of PBKDF2 per guess that's far out of reach.
const WORDS = (
  'acorn admiral amber anchor apple april arcade arrow atlas autumn avocado badge bakery bamboo banjo barley ' +
  'basket beacon beetle berry bicycle biscuit blanket blossom bonfire bottle bramble breeze brick bridge bubble bucket ' +
  'buffalo bundle butter cabin cactus camel candle canoe canyon captain carbon carpet carrot castle cedar cello ' +
  'chalk channel cherry chimney cinema circus citrus clover cobalt coconut comet compass copper coral cotton cougar ' +
  'cradle crayon cricket crystal cupboard cushion dahlia daisy dancer delta denim desert dial diesel dolphin domino ' +
  'donkey dragon drum eagle easel echo eclipse elbow ember emerald engine falcon feather fennel ferry fiddle fig ' +
  'flamingo flannel flute forest fossil fountain fox galaxy garden garlic gecko ginger glacier globe goblet golden ' +
  'gondola gorilla granite grape gravel guitar hammock harbor harvest hazel hedgehog helmet heron hickory honey horizon ' +
  'iceberg igloo indigo island ivory jacket jaguar jasmine jelly jigsaw jungle kayak kettle kiwi koala ladder ' +
  'lagoon lantern lava lemon lily lobster locket lotus lumber magnet mango maple marble meadow melon meteor ' +
  'mint mirror mitten monsoon mosaic mountain muffin mushroom napkin nectar needle nutmeg oasis ocean olive onion ' +
  'orbit orchid otter paddle palace panda papaya parade parrot pebble pelican pepper piano pickle pigeon pillow ' +
  'pine planet plum pocket pony poppy potato pretzel pumpkin puzzle quartz quill rabbit radish rainbow raven ' +
  'reef ribbon river rocket rose saddle saffron sailor salmon sandal satchel sequoia shadow shell sierra silver ' +
  'sketch sleigh slipper snail sparrow spinach sponge spruce squirrel stadium starfish summit sunflower swan tablet ' +
  'tamarind teapot temple thistle thunder tiger timber tomato topaz tortoise tractor trumpet tulip tundra turnip ' +
  'umbrella valley velvet violin volcano wafer walnut walrus wander willow window winter yogurt zebra zephyr'
).split(' ');

/** Six random words, e.g. "otter maple lantern quartz harbor fig". */
export function suggestPassphrase(count = 6) {
  const picks = globalThis.crypto.getRandomValues(new Uint32Array(count));
  return [...picks].map(n => WORDS[n % WORDS.length]).join(' ');
}

export const WORD_COUNT = WORDS.length;
