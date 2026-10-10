// A worker or worklet built by Vite as a file of its own: its address.
declare module '*?worker&url' {
  const url: string;
  export default url;
}
