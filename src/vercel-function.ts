import { handleApi } from "./http.js";

export default {
  fetch(request: Request) {
    return handleApi(request);
  },
};
