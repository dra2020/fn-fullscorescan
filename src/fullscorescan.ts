// Shared libraries
import * as Util from '@dra2020/util';
import * as OT from '@dra2020/ot-js';
import * as OTE from '@dra2020/ot-editutil';
import * as Context from '@dra2020/context';
import * as LogAbstract from '@dra2020/logabstract';
import * as Storage from '@dra2020/storage';
import * as FSM from '@dra2020/fsm';
import * as DB from '@dra2020/dbabstract';
import * as DT from '@dra2020/dra-types';
import * as Lambda from '@dra2020/lambda';


// App libraries
import { Environment } from './env';

let UniqueState = FSM.FSM_CUSTOM1;
const FSM_QUERYING = UniqueState++;
const FSM_PROCESSING = UniqueState++;
const FSM_BUILDING = UniqueState++;

const ScoreVersion = '2';
const MaxInParallel = 400;

function NeedScoreBuild(env: Environment, sp: OT.SessionProps, force: boolean): boolean
{
  return (sp.modifyTime && (sp.modifyTime !== sp.xprops.scoreTime || force))
          || (sp.xprops.scoreVersion !== ScoreVersion && sp.xprops.scoreVersion != '0');
}

const MaxQueries = 20;

export class FsmFullScoreScan extends FSM.Fsm
{
  query: DB.DBQuery;
  toProcess: any[][];
  fsmBuilds: Lambda.FsmInvoke[];
  force: boolean;
  numberSkipped: number;
  numberBuilt: number;

  constructor(env: Environment, force?: boolean)
  {
    super(env);
    this.query = null;
    this.toProcess = [];
    this.fsmBuilds = [];
    this.force = force;
    this.numberSkipped = 0;
    this.numberBuilt = 0;
  }

  get env(): Environment { return this._env as Environment; }

  next(): void
  {
    // Print out result of last set
    this.fsmBuilds.forEach((i) => {
        if (i.result && i.result.chatters)
          i.result.chatters.forEach((s: string) => { this.env.log.chatter(s) })
        if (i.result && i.result.numberSkipped !== undefined)
          this.numberSkipped += i.result.numberSkipped;
        if (i.result && i.result.numberBuilt !== undefined)
          this.numberBuilt += i.result.numberBuilt;
      });

    // Now invoke this set
    console.log(`buildscore: toProcess length is ${this.toProcess.length}`);
    this.fsmBuilds = [];
    while (this.toProcess.length > 0 && this.fsmBuilds.length < MaxInParallel)
    {
      let queries = this.toProcess.pop();
      this.fsmBuilds.push(this.env.lambdaManager.invoke('buildScore', { queries: queries, force: this.force }));
    }

    // If nothing added, we are done.
    if (this.fsmBuilds.length == 0)
    {
      this.env.log.chatter(`fullscorescan: ${this.numberBuilt} maps scored, ${this.numberSkipped} maps skipped`);
      this.setState(FSM.FSM_DONE);
    }
    else
    {
      this.waitOn(this.fsmBuilds);
      this.setState(FSM_BUILDING);
    }
  }

  tick(): void
  {
    if (this.ready && this.isDependentError)
    {
      // Don't allow one failure to stop processing, unless it happens during querying
      if (this.state == FSM_QUERYING)
        this.setState(FSM.FSM_ERROR);
      else
        this.clearDependentError();
    }
    if (this.ready)
    {
      switch (this.state)
      {
        case FSM.FSM_STARTING:
          this.env.log.event('fullscorescan: starting scan for work');
          this.query = this.env.db.createQuery(this.env.col, {});
          this.waitOn(this.query);
          this.setState(FSM_QUERYING);
          break;

        case FSM_QUERYING:
          let spProcess: OT.SessionProps[] = this.query.result.filter((sp: OT.SessionProps) => NeedScoreBuild(this.env, sp, this.force));

          // Sort so that we optimize download of geo data
          spProcess.sort((sp1: any, sp2: any) => {
              let s1 = `${sp1.xprops.state}.${sp1.xprops.datasource}`;
              let s2 = `${sp2.xprops.state}.${sp2.xprops.datasource}`;
              if (s1 < s2) return -1;
              if (s2 < s1) return 1;
              return 0;
            });
          this.toProcess = [];
          for (let i = 0; i < spProcess.length; )
          {
            let queries: any[] = [];
            let spMatch: any = spProcess[i];

            for (let j = 0; i < spProcess.length && j < MaxQueries; i++, j++)
            {
              let sp: any = spProcess[i];
              if (sp.xprops.state === spMatch.xprops.state && sp.xprops.datasource === spMatch.xprops.datasource)
                queries.push({ id: sp.id, createdBy: sp.createdBy });
            }
            this.toProcess.push(queries);
          }

          this.env.log.value({ event: 'fullscorescan: building queue size', value: this.toProcess.length });
          delete this.query;  // free memory
          this.setState(FSM_PROCESSING);
          break;

        case FSM_PROCESSING:
          this.next();
          break;

        case FSM_BUILDING:
          this.setState(FSM_PROCESSING);
          break;
      }
    }
  }
}
