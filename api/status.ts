import { handleApi } from "../src/http.ts";

export default {
  fetch(request: Request) {
    return handleApi(request);
  },
};
