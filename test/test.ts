import * as FSS from '../src/fn-fullscorescan';

FSS.fullScoreScan(
  { force: false },
  null,
  (err: any, result: any) => {
      if (err)
        console.log(`fullScoreScan: error: ${JSON.stringify(err)}`);
      else
        console.log(`fullScoreScan: result: ${JSON.stringify(result)}`);
    });
