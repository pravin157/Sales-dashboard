import { handleApi } from "../src/http.ts";

export const maxDuration = 60;

export default {
  fetch(request: Request) {
    return handleApi(request);
  },
};
