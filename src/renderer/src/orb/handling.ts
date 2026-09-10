/** A handled vessel's pose and acceleration. Releasing keeps spring velocity,
 * so the water receives the rebound rather than snapping back to rest. */
export class Handling {
  private x={position:0,velocity:0};
  private y={position:0,velocity:0};
  private target=[0,0];
  grab(x:number,y:number){this.target=[Math.max(-1,Math.min(1,x)),Math.max(-1,Math.min(1,y))];}
  release(){this.target=[0,0];}
  step(dt:number){
    const vx=this.x.velocity,vy=this.y.velocity;
    // Exact critically damped handling spring. Keep the lazy GPU runtime free
    // of imports from expression/UI state, so it also runs in isolated canvases.
    for(const [index,state] of [this.x,this.y].entries()){
      const offset=state.position-this.target[index],b=state.velocity+9*offset,decay=Math.exp(-9*dt);
      state.position=this.target[index]+(offset+b*dt)*decay;
      state.velocity=(state.velocity-9*b*dt)*decay;
    }
    const limit=(value:number)=>Math.max(-7,Math.min(7,value));
    return {roll:-this.x.position*.22,pitch:this.y.position*.16,
      ax:dt>0?limit(-(this.x.velocity-vx)/dt*.22):0,
      ay:dt>0?limit(-(this.y.velocity-vy)/dt*.16):0};
  }
}
