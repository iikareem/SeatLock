# Runbook

Operational procedures for SeatLock.

## Local AWS with MiniStack

SeatLock uses [MiniStack](https://github.com/ministackorg/ministack) as the local AWS emulator (DynamoDB, Lambda, SQS, Step Functions, EventBridge, etc. on port `4566`).

### Start

```bash
docker compose up -d
curl http://localhost:4566/_ministack/health
```

Or: `npm run ministack:up`

### Point SDKs / CLI at MiniStack

```bash
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
```

Copy from `.env.example` if you prefer a file.

### Deploy infra to MiniStack (later)

```bash
npm install -g aws-cdk-local   # once
cd infra
cdklocal bootstrap
cdklocal deploy --all --context stage=dev
```

`cdklocal` sets `AWS_ENDPOINT_URL=http://localhost:4566` for you.

### Reset state between test runs

```bash
curl -X POST http://localhost:4566/_ministack/reset
# or: npm run ministack:reset
```

### Stop

```bash
docker compose down
# or: npm run ministack:down
```

### Useful MiniStack inspect endpoints

```bash
curl http://localhost:4566/_ministack/health
curl http://localhost:4566/_ministack/sqs/messages
curl http://localhost:4566/_ministack/ses/messages
```

## TODO

- Replay refund DLQ
- Run loadgen and auditor after a sale
- Cancel an event and watch RefundBatch complete
- Billing alarm checklist before real AWS deploy
