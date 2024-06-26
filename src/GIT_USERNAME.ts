import DIE from "@snomiao/die";
import { GIT_USEREMAIL } from "./GIT_USEREMAIL";
import { ghUser } from "./ghUser";

export const GIT_USERNAME =
  process.env.GIT_USERNAME || (ghUser.email && ghUser.name) || DIE("Missing env.GIT_USERNAME");

// read env/parameters
console.log(`GIT COMMIT USER: ${GIT_USERNAME} <${GIT_USEREMAIL}>`);
