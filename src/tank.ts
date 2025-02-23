import {Composite, Vector as Vector, Vertices} from 'matter-js';
import {Bodies,Body,Engine} from 'matter-js';
import { nstr,limitAngle } from './utils';
import Script from './script';
import { Game } from './game';

type Controls = {
  turn_gun: number,
  turn_radar: number,
  left_track_speed: number,
  right_track_speed: number,
  fire_gun: boolean,
}

type RadarData = {
  wall: boolean,
  enemies: RadarHit[],
  allies: RadarHit[],
  bullets: RadarHit[],
}

type RadarHit = {
  distance:number,
  angle:number,
  velocity: Vector,
  energy: number|undefined,
}

type Sensors = {
  radar_hits: RadarData,
  speed: number,
  direction: number,
  gun_angle: number,
  radar_angle: number,
  energy: number,
  impact: boolean,
}

// Questions:
//   - How do I make this thing have collision detection?
//   - What should I do when a collision happens? move and slide? crash?
//   - Should tanks be able to push each other around?
//   - Should the drives be applying forces instead of just setting speeds?
//
// I could model this as a rigid body that has collisions, and use forces as a thrust
// on each wheel. If I do that, I need to implement a sideways friction force that 
// prevents the tanks from sliding sideways (maybe with a limit, so they can drift?).
// I could just directly cancel all velocity that is not along the axis of motion, 
// effectively giving the tank infinite traction.
export default class Tank{
  wheel_base:number
  gun_angle: number
  energy: number
  gun_charge: number
  radar_angle: number
  radar_speed: number
  gun_speed: number
  left_speed: number
  right_speed: number
  max_energy: number 
  max_speed: number
  delta_t: number
  body: Body
  code: Script
  controls: Controls
  update_handler:undefined|((t:Tank)=>void) = undefined
  starting_pos: Vector
  radar_body: Body
  turret_body: Body
  radar_verts: Vertices
  
  static min_turn_angle: number=0.00001
  static width:number = 20
  static length:number = 25 
  static max_energy: 100 
  static max_speed:number = 200
  static max_radar_speed:number = 2*Math.PI
  static radar_range:number = 200
  static max_gun_speed:number = Math.PI/2
  
  static default_code = `
import {TankAPI,Controls,Sensors} from './tank-api';

export function setup() {

}

export function loop(api:TankAPI) {
  let controls = api.getControls();
  let sensors = api.getSensors();
  //your code here.
  api.setControls(controls);
}
`;
  constructor(pos:Vector, extra_globals: any) {
    this.starting_pos = pos;
    this.body = Bodies.rectangle(pos.x, pos.y, Tank.length, Tank.width,{label:"Tank Body"});
    this.body.frictionAir = 0;
    this.max_energy = Tank.max_energy;
    this.gun_angle = 0;
    this.wheel_base = Tank.width;
    Body.setAngle(this.body,0);
    this.gun_charge = 1;
    this.left_speed = 0;
    this.right_speed = 0;
    this.energy = this.max_energy;
    this.max_speed = 100;
    this.delta_t = 0.016;
    this.gun_speed = 0;
    this.radar_speed = 0;
    this.radar_angle = 0;
    let half_ms = Tank.max_radar_speed/(2*Game.sim_fps);
    let verts = [
        [0,-Math.sin(half_ms)/3],
        [Math.cos(half_ms),-Math.sin(half_ms)],
        [1,0],
        [Math.cos(half_ms),Math.sin(half_ms)],
        [0,Math.sin(half_ms)/3]
      ].map((pt)=>Vector.mult(Vector.create(pt[0],pt[1]),Tank.radar_range));
    
    this.radar_body = Bodies.fromVertices(0,0,[verts],
      {
        label:"radar",
        isSensor:true,
        render:{
          visible:false,
          opacity: 0.5,
          fillStyle: '#fff',
          lineWidth: 0,
        }
      });
    
    this.radar_body.frictionAir = 0;
    Body.setCentre(this.radar_body, Vector.create(this.radar_body.bounds.min.x+1,0));
    Body.setPosition(this.radar_body, this.body.position);
    this.radar_body.render.fillStyle = '#fff';
    let barrel = Bodies.rectangle(15,0,18,2,{
      isSensor:true,
    });
    this.turret_body = Body.create({isSensor:true});
    let turret = Bodies.rectangle(0,0,12,9,{
      label:"turret",
      isSensor:true,
      render:{
        opacity:1,
        fillStyle: '#141',
        visible:true,
      }
    });
    Body.setParts(this.turret_body,[turret,barrel]);
    Body.setCentre(this.turret_body, Vector.create(this.turret_body.bounds.min.x+6,0));
     
  
    // Add globals for the tank
    extra_globals.getSensors= this.getSensors.bind(this);
    extra_globals.getControls= this.getControls.bind(this);
    extra_globals.setControls= this.setControls.bind(this);
    extra_globals.getDeltaT= this.getDeltaT.bind(this);
    
    this.code = new Script('', Script.addDefaultGlobals(extra_globals));
    this.controls = {
      turn_gun: 0,
      turn_radar: 0,
      left_track_speed: 0,
      right_track_speed: 0,
      fire_gun: false,
    };
  }

  println(...args:any[]):void {
    let content = document.querySelector('#output').innerHTML;
    content += `${args.map((s)=>JSON.stringify(s)).join('')}\n`;
    document.querySelector('#output').innerHTML = content;
  }

  add_to_world(world:Composite) { 
    Composite.add(world,this.body);
    Composite.add(world,this.radar_body);
    Composite.add(world,this.turret_body);
    console.log(world.bodies);
  }

  onUpdate(hdler:(t:Tank)=>void, skip:number = 100) {
    let count:number = 1;
    let self = this;
    this.update_handler = ()=>{
      if(count % skip == 0) {
        hdler(this);
      }
      count += 1;
    }
  }

  reset() {
    Body.setPosition(this.body, this.starting_pos);
    Body.setVelocity(this.body,Vector.create(0,0));
    Body.setAngle(this.body,0);
    Body.setAngularSpeed(this.body, 0);
    Body.setPosition(this.radar_body, this.body.position);
    Body.setAngle(this.radar_body,0);
    this.code.update('');
  }

  update(delta_t: number) {
    Body.setAngle(this.body, limitAngle(this.body.angle));
    Body.setPosition(this.radar_body, this.body.position);
  
    this.radar_speed = this.controls.turn_radar;
    this.radar_angle += this.radar_speed * delta_t;
    Body.setAngle(this.radar_body, this.radar_angle);
  
    this.gun_speed = this.controls.turn_gun;
    this.gun_angle += this.gun_speed * delta_t;
    Body.setPosition(this.turret_body,this.body.position);
    Body.setAngle(this.turret_body, this.body.angle+this.gun_angle);

    this.left_speed = this.controls.left_track_speed;
    this.right_speed = this.controls.right_track_speed;
    let limited = Math.max(this.left_speed,this.right_speed);
    if(limited > Tank.max_speed) {
      console.log(`WARNING: limiting tank speed to ${Tank.max_speed}, requested speed was ${limited}`);
      this.left_speed *= Tank.max_speed/limited;
      this.right_speed *= Tank.max_speed/limited;
    }
    let delta_angle = (this.left_speed - this.right_speed)*delta_t / this.wheel_base;
    let angle = this.body.angle;
    let velocity = Vector.mult(Vector.create(Math.cos(angle), Math.sin(angle)), (this.left_speed+this.right_speed)/2);
    Body.setAngularVelocity(this.body, delta_angle);
    Body.setVelocity(this.body, Vector.mult(velocity,1/Game.sim_fps));
    if(this.update_handler) {
      this.update_handler(this);
    }
  }

  
  show():string {
    return `Tank pose: `
      +` left: ${nstr(this.left_speed)}`
      +` right: ${nstr(this.right_speed)}`
      +` pos=(${nstr(this.body.position.x)},${nstr(this.body.position.y)})`
      +` ang=${nstr(this.body.angle)}` 
      +` angvel=${nstr(this.body.angularVelocity*Game.sim_fps)}`
      +` vel=(${nstr(this.body.velocity.x*Game.sim_fps)},${nstr(this.body.velocity.y*Game.sim_fps)})`
      ;
  }

  setCode(code:string) {
    this.code.update(code);
  }

  getSensors() : Sensors {
    let rd = {
      wall: false,
      enemies: [],
      allies: [],
      bullets: [],
    } as RadarData;
    
    return {
      radar_hits: rd,
      speed: Game.sim_fps*(this.left_speed+this.right_speed)/2,
      direction:this.body.angle,
      gun_angle:this.gun_angle,
      radar_angle: this.radar_angle,
      energy: this.energy,
      impact: false,
    } as Sensors;
  }

  getControls() {
    return this.controls;
  }
 
  getDeltaT() {
    return this.delta_t;
  }
  
  setControls(controls:Controls) {
    if(controls) {
      this.controls = controls;
    }
  }
  
  control(delta_t: number) {
    this.delta_t = delta_t;
    this.code.execute();
  }
}

