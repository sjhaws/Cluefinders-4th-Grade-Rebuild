import type { Value } from './ScriptVm';
import { GenericObject, type ScriptObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { RScenePort, RWorldPort } from './WorldState';
import { RAnimation, RDialog, RHotSpot, RPButton, RSmackerMovie, RText } from './DisplayObjects';
import { RLapTrap } from './LapTrap';
import { RSelList } from './SelList';
import { RCompositeAction, RKbdInp, RQueue } from './Queue';
import { RCharacter } from './Character';
import { RBackPack } from './BackPack';
import {
  RAttributeContainer,
  RDoubleGraphicTextAnswer,
  RGraphicAnswer,
  RGraphicTextAnswer,
  RHorizontalValueContainer,
  RPuzzle,
  RValueContainer,
} from './Puzzle';
import { OMMultiTrinket } from './Trinket';

type Factory = (engine: GameEngine, args: Value[]) => ScriptObject;

/** Script-visible class names from 4THADV32.EXE; unimplemented ones become GenericObject. */
const KNOWN_CLASSES = [
  'Action', 'ActionContainer', 'AnimAction', 'BigOleButtonGroup', 'CharacterAnimAction',
  'CharacterSpeechAction', 'DelayAction', 'EffectsWindow', 'IntProperty', 'MapAction', 'MoveXAction',
  'MoveXYAction', 'MoveYAction', 'MovieAction', 'OMAnimation', 'OMMultiTrinket', 'OMPopUpMenu',
  'OMTCursor', 'OMTrinket', 'OMTrinketWindow', 'PlayAnimAction', 'Player', 'PropertyAction',
  'RAnimation', 'RAnimationTrigger', 'RAnswer', 'RAttributeContainer', 'RBackPack', 'RCharacter',
  'RContainer', 'RDialog', 'RDoubleGraphicTextAnswer', 'RFabricContainer', 'RGraphicAnswer',
  'RGraphicTextAnswer', 'RHorizontalContainer', 'RHorizontalValueContainer', 'RHotSpot', 'RKbdInp',
  'RLapTrap', 'RMap', 'RPButton', 'RPegGame', 'RPentominoGame', 'RPuzzle', 'RQueue', 'RRandomAction',
  'RScenePort', 'RSelList', 'RSmackerMovie', 'RStackingContainer', 'RText', 'RTrigger',
  'RValueContainer', 'RWorldPort', 'RandomDelayAction', 'SoundAction', 'StringProperty', 'VerbAction',
  'YThread',
];

const IMPLEMENTED: Record<string, Factory> = {
  rworldport: (e) => new RWorldPort(e),
  rsceneport: (e) => new RScenePort(e),
  ranimation: (e, a) => new RAnimation(e, a),
  rpbutton: (e, a) => new RPButton(e, a),
  rtext: (e, a) => new RText(e, a),
  rsmackermovie: (e, a) => new RSmackerMovie(e, a),
  rdialog: (e, a) => new RDialog(e, a),
  rlaptrap: (e, a) => new RLapTrap(e, a),
  rsellist: (e, a) => new RSelList(e, a),
  rqueue: (e) => new RQueue(e),
  rcompositeaction: (e) => new RCompositeAction(e),
  rkbdinp: (e) => new RKbdInp(e),
  rcharacter: (e, a) => new RCharacter(e, a),
  rhotspot: (e, a) => new RHotSpot(e, a),
  rbackpack: (e, a) => new RBackPack(e, a),
  rpuzzle: (e) => new RPuzzle(e),
  rgraphicanswer: (e, a) => new RGraphicAnswer(e, a),
  rgraphictextanswer: (e, a) => new RGraphicTextAnswer(e, a),
  rvaluecontainer: (e, a) => new RValueContainer(e, 'RValueContainer', a.slice(0, 5).map(Number), a[5]),
  rattributecontainer: (e, a) => new RAttributeContainer(e, a),
  rdoublegraphictextanswer: (e, a) => new RDoubleGraphicTextAnswer(e, a),
  ommultitrinket: (e) => new OMMultiTrinket(e),
  rhorizontalvaluecontainer: (e, a) => new RHorizontalValueContainer(e, a),
};

export const CLASSES = new Map<string, Factory>();
for (const name of KNOWN_CLASSES) CLASSES.set(name.toLowerCase(), (e) => new GenericObject(e, name));
for (const [name, factory] of Object.entries(IMPLEMENTED)) CLASSES.set(name, factory);
