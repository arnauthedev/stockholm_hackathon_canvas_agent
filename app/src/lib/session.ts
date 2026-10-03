/** One text conversation per page load, shared by the text sheet and photo uploads. */
let id: string | undefined;
export const textSessionId = () => id;
export const setTextSessionId = (v: string) => (id = v);
