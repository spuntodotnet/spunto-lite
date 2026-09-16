// What the project form offers to pick from.
//
// The lists themselves are `@spunto/build/catalogs`, shared with Spunto Cloud: they are data, but
// *agreed* data — two hand-maintained copies had already drifted, which is how a feature ends up
// advertising an option the image recipe disables.
//
// Spunto Lite adds two base images on top, and nothing else. They are not a local preference, just
// entries that haven't been folded into the package yet — deleting them would quietly remove two
// choices from the picker. Existing projects are unaffected either way: a project stores the image
// *reference* it was created with, not a catalog id.

import { AVAILABLE_IMAGES as SHARED_IMAGES, type DevImage } from "@spunto/build/catalogs"

export { AVAILABLE_FEATURES, SUGGESTED_EXTENSIONS } from "@spunto/build/catalogs"
export type { DevFeature, DevFeatureOption, DevImage } from "@spunto/build/catalogs"

/** Offered by Lite but not yet in the shared catalog — see the note above. */
const LITE_ONLY_IMAGES: DevImage[] = [
  {
    id: "universal",
    label: "Universal (multi-language)",
    image: "mcr.microsoft.com/devcontainers/universal:2",
    description: "Node, Python, Go, Java, Ruby, PHP… (large)",
  },
  {
    id: "base-ubuntu",
    label: "Ubuntu (base)",
    image: "mcr.microsoft.com/devcontainers/base:ubuntu",
    description: "Plain Ubuntu, add features as needed",
  },
]

export const AVAILABLE_IMAGES: DevImage[] = [...SHARED_IMAGES, ...LITE_ONLY_IMAGES]
