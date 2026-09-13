import {AgentEventStore} from '/Users/ray/dev/shepy-wt/waitfix/src/db/agent-events.ts';
import {applyMigrations} from '/Users/ray/dev/shepy-wt/waitfix/src/db/apply-migrations.ts';
import {openSqlite} from '/Users/ray/dev/shepy-wt/waitfix/src/db/client.ts';
import {HerdrSessionStore} from '/Users/ray/dev/shepy-wt/waitfix/src/db/herdr-sessions.ts';
import {OperationStore} from '/Users/ray/dev/shepy-wt/waitfix/src/db/operations.ts';
import {OrchestratorProfileStore} from '/Users/ray/dev/shepy-wt/waitfix/src/db/orchestrator-profiles.ts';
import {OperationWaitService} from '/Users/ray/dev/shepy-wt/waitfix/src/observability/operation-wait-service.ts';
import {HerdrOrchestrationTransportAdapter} from '/Users/ray/dev/shepy-wt/waitfix/src/herdr/orchestration-transport-adapter.ts';
const T = 1789329600000;
const target = {agentSession:'original-session',herdrSessionName:'default',paneId:'synthetic-pane',terminalId:'synthetic-terminal',workspaceId:'synthetic-workspace'};
function fixture() {
	const {sqlite} = openSqlite(':memory:');
	applyMigrations(sqlite,{migrationsFolder:'/Users/ray/dev/shepy-wt/waitfix/drizzle'});
	const sessions = new HerdrSessionStore(sqlite);
	for(const name of ['default','other']) sessions.upsertRunning({name,sessionDir:'/synthetic',socketPath:'/synthetic/no-socket'});
	new OrchestratorProfileStore(sqlite).createProfile({displayName:'synthetic',profileId:'synthetic',projectRoots:[]});
	const events = new AgentEventStore(sqlite); const operations = new OperationStore(sqlite); const wait = new OperationWaitService({events,operations});
	function row(to:string,at:number,options:{terminal?:string;session?:string;native?:string;raw?:string}={}) {
		sqlite.prepare('insert into agent_events (created_at,herdr_session_name,pane_id,terminal_id,type,workspace_id,payload_json) values (?,?,?,?,?,?,?)').run(at,options.session??target.herdrSessionName,target.paneId,options.terminal??target.terminalId,'agent.status.changed',target.workspaceId,options.raw??JSON.stringify({...target,agentSession:options.native??target.agentSession,from:'unknown',to}));
	}
	function operation(at=T) {
		const op = operations.create({herdrSessionName:target.herdrSessionName,profileId:'synthetic',prompt:'synthetic-only',target,workspaceId:target.workspaceId});
		sqlite.prepare('update orchestration_operations set created_at=? where id=?').run(at,op.id);
		operations.recordSubmission({operationId:op.id,requestId:'synthetic',submittedAt:new Date(at+1)}); return op.id;
	}
	return {sqlite,row,operation,operations,wait,finish:(id:string)=>wait.applyLifecycle(id,{kind:'settled',operationId:id,target})};
}
const results: {name:string;actual:string;expected:string;pass:boolean;scope:string}[]=[];
function check(name:string,expected:string,fn:(f:ReturnType<typeof fixture>)=>string,scope='correction regression') {
	const f=fixture(); try {const actual=fn(f);results.push({name,actual,expected,pass:actual===expected,scope});} finally {f.sqlite.close();}
}
check('P-A prior start, later completion','target_not_started',f=>{f.row('working',T-2000);const id=f.operation();f.row('idle',T+1000);return f.finish(id).kind;});
check('P-B wholly prior epoch','target_not_started',f=>{f.row('working',T-4000);f.row('idle',T-1000);return f.finish(f.operation()).kind;});
check('prior start 1ms','target_not_started',f=>{f.row('working',T-1);const id=f.operation();f.row('idle',T+10);return f.finish(id).kind;});
check('genuine indexed post-create epoch','settled',f=>{const id=f.operation();f.row('working',T+2);f.row('idle',T+10);return f.finish(id).kind;});
check('malformed start ignored','target_not_started',f=>{const id=f.operation();f.row('working',T+2,{raw:'{broken'});f.row('idle',T+10);return f.finish(id).kind;});
check('malformed settled ignored','target_not_started',f=>{const id=f.operation();f.row('working',T+2);f.row('idle',T+10,{raw:'{broken'});return f.finish(id).kind;});
check('foreign terminal completion','target_not_started',f=>{const id=f.operation();f.row('working',T+2);f.row('idle',T+10,{terminal:'other'});return f.finish(id).kind;});
check('foreign Herdr session epoch','target_not_started',f=>{const id=f.operation();f.row('working',T+2,{session:'other'});f.row('idle',T+10,{session:'other'});return f.finish(id).kind;});
check('earliest epoch remains visible','settled',f=>{const id=f.operation();f.row('working',T+2);f.row('idle',T+10);f.row('working',T+11);return f.finish(id).kind;});
check('already-indexed old epoch shares creation millisecond','target_not_started',f=>{f.row('working',T);f.row('idle',T);const id=f.operation();return f.finish(id).kind;},'residual counterexample: no index lag');
check('replacement native session on same terminal','target_not_started',f=>{const id=f.operation();f.row('working',T+2,{native:'replacement-session'});f.row('idle',T+10,{native:'replacement-session'});return f.finish(id).kind;},'uncovered identity boundary; not claimed introduced by candidate');
check('two created operations share one execution','target_not_started',f=>{f.operation(T-1);const second=f.operation(T);f.row('working',T+2);f.row('idle',T+10);return f.finish(second).kind;},'already disclosed unattributable overlap');
const adapter = new HerdrOrchestrationTransportAdapter({promptAgent:async()=>({requestId:'unused',result:{}}),waitForAgent:async()=>({requestId:'synthetic',result:{agent:{agent_status:'idle',agent_session:{kind:'id',value:'replacement-session'},terminal_id:target.terminalId,pane_id:target.paneId}}})});
const response=await adapter.waitForLifecycle('op_synthetic',target);
console.log(JSON.stringify({candidate:'37c9b0ba54d30295ad5479bf6e4041be51bc6726',method:'Real stores/service, synthetic in-memory rows and stubbed Herdr boundary; no live operations or schema mutation',results,adapterReplacement:{kind:response.kind,returnedSession:response.target.agentSession,actualStubSession:'replacement-session',note:'Adapter echoes requested identity; does not validate returned native session. Pre-existing behavior.'}},null,2));
