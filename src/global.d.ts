// Tells TypeScript that importing an .html file returns a string.
// Webpack's asset/source loader handles the actual transformation at build time.
declare module '*.html' {
  const source: string;
  export default source;
}
