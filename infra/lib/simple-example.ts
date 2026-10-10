/**
 * SIMPLE INFRA EXAMPLE (teaching file)
 *
 * This is what "infra" means: you describe AWS resources in code.
 * CDK turns this into CloudFormation and creates them on deploy.
 *
 * Mental model:
 *   services/hold-seat  = the function logic (business code)
 *   infra               = create Lambda + table + HTTP route, then connect them
 *
 * Not wired into the app yet — read this to learn. Real stacks come later.
 *
 * Local deploy target: MiniStack on http://localhost:4566
 *   docker compose up -d
 *   cdklocal deploy
 */

/*
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import * as path from "path";

export class SimpleExampleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) Create a DynamoDB table (the "database")
    const seatsTable = new dynamodb.Table(this, "SeatsTable", {
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "seatId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // 2) Create a Lambda from your service code
    const holdSeatFn = new lambda.Function(this, "HoldSeatFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../services/hold-seat/src")
      ),
      environment: {
        SEATS_TABLE_NAME: seatsTable.tableName, // tell the function which table
      },
    });

    // 3) Allow that Lambda to read/write the table
    seatsTable.grantReadWriteData(holdSeatFn);

    // 4) Put an HTTP API in front of the Lambda
    const api = new apigateway.RestApi(this, "SeatLockApi", {
      restApiName: "seatlock-simple",
    });

    // POST /holds  →  runs holdSeatFn
    const holds = api.root.addResource("holds");
    holds.addMethod("POST", new apigateway.LambdaIntegration(holdSeatFn));
  }
}
*/

export const SIMPLE_INFRA_EXAMPLE = `
Buyer calls POST /holds
        │
        ▼
  API Gateway  ──────────────┐  (created by infra)
        │                    │
        ▼                    │
  HoldSeat Lambda  ◄─────────┤  (code from services/hold-seat)
        │                    │
        ▼                    │
  DynamoDB Seats table  ◄────┘  (created by infra)
`;
