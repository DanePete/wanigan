import studioUrl from './assets/studio_small_04_1k.hdr?url';
import backdropUrl from '../assets/mission-studio.png?url';

/** The room behind the vessel is a textured plane in the optical scene. Its
 * camera rays pass through both simulated water and the glass interfaces. */
export async function loadBackdrop(device:GPUDevice):Promise<GPUTexture> {
  const response=await fetch(backdropUrl);
  if(!response.ok)throw new Error('The bundled room could not be loaded');
  const bitmap=await createImageBitmap(await response.blob());
  try {
    const texture=device.createTexture({label:'Mission room optical backdrop',size:[bitmap.width,bitmap.height],
      format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    device.queue.copyExternalImageToTexture({source:bitmap},{texture},[bitmap.width,bitmap.height]);
    return texture;
  } finally {bitmap.close();}
}

/** Bounded Radiance RGBE decoder for our bundled CC0 studio lighting texture.
 * No network assets, arbitrary image input, or third-party loader at runtime. */
export async function loadStudio(device:GPUDevice):Promise<GPUTexture> {
  const response=await fetch(studioUrl);
  if(!response.ok)throw new Error('The bundled studio lighting could not be loaded');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>4_000_000)throw new Error('Unexpected lighting asset size');
  let cursor=0;
  const byte=()=>{if(cursor>=bytes.length)throw new Error('Incomplete lighting asset');return bytes[cursor++];};
  const line=()=>{let value='';for(let i=0;i<1024;i++){const c=byte();if(c===10)return value;value+=String.fromCharCode(c);}throw new Error('Invalid lighting header');};
  if(!line().startsWith('#?'))throw new Error('Invalid lighting asset');
  let format=false;
  for(let n=0;n<30;n++){const value=line();if(value==='')break;if(value==='FORMAT=32-bit_rle_rgbe')format=true;}
  const dimensions=/^-Y (\d+) \+X (\d+)$/.exec(line());
  if(!format||!dimensions)throw new Error('Unsupported lighting format');
  const height=Number(dimensions[1]),width=Number(dimensions[2]);
  if(width!==1024||height!==512)throw new Error('Unexpected lighting dimensions');
  const scanline=new Uint8Array(width*4),pixels=new Uint16Array(width*height*4);
  const bits=new DataView(new ArrayBuffer(4));
  const half=(value:number)=>{
    bits.setFloat32(0,Math.min(65000,Math.max(0,value)));const x=bits.getUint32(0);
    const exp=((x>>>23)&255)-112, mantissa=x&0x7fffff;
    if(exp<=0)return exp < -10 ? 0 : (((mantissa|0x800000) >>> (1-exp))+0x1000)>>>13;
    return (exp<<10)|((mantissa+0x1000)>>>13);
  };
  for(let y=0;y<height;y++){
    if(byte()!==2||byte()!==2||((byte()<<8)|byte())!==width)throw new Error('Invalid lighting scanline');
    for(let channel=0;channel<4;channel++){
      let x=0;
      while(x<width){
        const run=byte(),count=run>128?run-128:run;
        if(count===0||x+count>width)throw new Error('Invalid lighting run');
        if(run>128){const value=byte();for(let i=0;i<count;i++)scanline[(x++)*4+channel]=value;}
        else for(let i=0;i<count;i++)scanline[(x++)*4+channel]=byte();
      }
    }
    for(let x=0;x<width;x++){
      const exponent=scanline[x*4+3],factor=exponent?2**(exponent-136):0,offset=(y*width+x)*4;
      for(let c=0;c<3;c++)pixels[offset+c]=half(scanline[x*4+c]*factor);
      pixels[offset+3]=0x3c00;
    }
  }
  const texture=device.createTexture({label:'Poly Haven Studio Small 04',size:[width,height],format:'rgba16float',
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture},pixels,{bytesPerRow:width*8},[width,height]);
  return texture;
}
