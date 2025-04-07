// process.env.CLOUDANT_URL='<user_name>.cloudantnosqldb.appdomain.cloud'; // for testing purposes only, remove in production
// process.env.CLOUDANT_APIKEY='<your_api_key>'; // for testing purposes only, remove in production

const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const fs = require('fs');

const util = require('util');
const fetch = require('node-fetch');
const querystring = require('querystring');

const { IamAuthenticator } = require('ibm-cloud-sdk-core');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const bootstrapDB = require('./scripts/bootstrapDB.js');

const app = express();
app.set('port', process.env.PORT || 8080);
app.use(bodyParser.json());

let cloudantService;

// For IAM authenticated Cloudant
let accessToken;
const iamTokenEndpoint = 'https://iam.cloud.ibm.com/identity/token';

async function getIamAccessToken() {
    const apiKey = process.env.CLOUDANT_APIKEY;
    if (!apiKey) {
        console.error("ERROR: CLOUDANT_APIKEY not set in environment variables.");
        return null;
    }

    const params = querystring.stringify({
        apikey: apiKey,
        grant_type: 'urn:ibm:params:oauth:grant-type:apikey'
    });

    try {
        const response = await fetch(iamTokenEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: params
        });

        if (!response.ok) {
            const error = await response.json();
            console.error('Error fetching IAM token:', error);
            return null;
        }

        const data = await response.json();
        accessToken = data.access_token;
        console.log('IAM access token retrieved successfully');
        return accessToken;
    } catch (error) {
        console.error('Error fetching IAM token:', error);
        return null;
    }
}

async function initializeCloudantWithToken() {
    const cloudantUrl = process.env.CLOUDANT_URL;
    if (!cloudantUrl) {
        console.error("ERROR: CLOUDANT_URL not set in environment variables.");
        return;
    }
    const token = await getIamAccessToken();
    // You can pass token directly to the Cloudant service and bypass the IAM token generation step. 
    // The token can be generated with: 
    // curl -X POST 'https://iam.cloud.ibm.com/identity/token' -H 'Content-Type: application/x-www-form-urlencoded' -d 'grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=<your_api_key>'
    // Then uncomment the below line and add the token value... a valid token should be able to be split in 3 parts per couchdb source code:
    //const token = '<insert_your_token_here>'; // For testing purposes only, remove in production
    if (!token) {
        console.error("ERROR: Unable to retrieve IAM access token.");
        return;
    }

    // From IAM docs (new Cloudant connection - not legacy) 
    const authenticator = new IamAuthenticator({
        apikey: process.env.CLOUDANT_APIKEY
    });
    cloudantService = new CloudantV1({
        authenticator: authenticator,
    });

    cloudantService.setServiceUrl(cloudantUrl);

    console.log("Connected to Cloudant with IAM token");
    bootstrapDB(cloudantUrl, cloudantService)
        .then(result => {
            console.log(result);
            http.createServer(app).listen(app.get('port'), '0.0.0.0', function() {
                console.log('Express server listening on port ' + app.get('port'));
            });
        })
        .catch(err => {
            console.error('Error during bootstrapping or server start:', err);
        });
}

// if environment variables for Cloudant connection exist initialize the JWT generation
if (process.env.CLOUDANT_URL && process.env.CLOUDANT_APIKEY) {
    initializeCloudantWithToken();
} else { // Check for legacy Cloudant connection (for older versions) if no environment variables are set
    let urlFromConfig;
    try {
        urlFromConfig = JSON.parse(fs.readFileSync("./credentials.json", "utf-8")).url;
    } catch (_) {
        console.log("Cannot find Cloudant credentials in environment or credentials.json.");
    }

    if (urlFromConfig) {
        const cloudantLegacy = require('@cloudant/cloudant'); // Keep for legacy Cloudant connection
        cloudantLegacy({ url: urlFromConfig }, function(err, conn) {
            if (err) {
                return console.log('Failed to initialize Cloudant with URL: ' + err.message);
            }
            cloudantService = conn; // Assign legacy connection to cloudantService
            console.log("Connected to Cloudant using URL (from config).");
            bootstrapDB(urlFromConfig, cloudantService)
                .then(result => {
                    console.log(result);
                    http.createServer(app).listen(app.get('port'), '0.0.0.0', function() {
                        console.log('Express server listening on port ' + app.get('port'));
                    });
                })
                .catch(err => {
                    console.error('Error during bootstrapping or server start:', err);
                });
        });
    }
}

// Enable CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Adjust for production
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

app.get('/api/patients', async function (_, res) {
    if (cloudantService) {
        try {
            const list = await cloudantService.postAllDocs({ db: 'patients', includeDocs: true });
            res.json(list.result.rows.map(row => row.doc));
        } catch (err) {
            console.error("Error listing patients:", err);
            res.status(500).send({ error: "Error listing patients" });
        }
    } else {
        res.status(500).send({ error: "Cloudant not initialized." });
    }
});

app.post('/api/login/user', async function(req, res){
    var username = req.body.UID;
    var password = req.body.PASS;

    if (cloudantService) {
        try {
            const findResult = await cloudantService.postFind({
                db: 'patients',
                selector: { user_id: username }
            });
            if (findResult && findResult.result && findResult.result.docs && findResult.result.docs.length > 0) {
                var patient = findResult.result.docs[0];
                var resData = {"ResultSet Output": [{
                    "CA_ADDRESS": patient.address,
                    "CA_CITY": patient.city,
                    "CA_DOB": patient.birthdate,
                    "CA_FIRST_NAME": patient.first_name,
                    "CA_GENDER": patient.gender,
                    "CA_LAST_NAME": patient.last_name,
                    "CA_POSTCODE": patient.postcode,
                    "CA_USERID": patient.user_id,
                    "PATIENTID": patient.patient_id
                }]};
                res.json(resData);
            } else {
                console.error(findResult);
                res.status(404).send({ error: `User "${username}" not found` });
            }
        } catch (err) {
            console.error(err);
            res.status(500).send({ error: `Error during login for user "${username}"` });
        }
    } else {
        res.status(500).send({ error: "Cloudant not initialized." });
    }
});

app.get('/api/getInfo/patients/:id', async function(req, res) {
    var patientID = req.params.id;

    if (cloudantService) {
        try {
            const findResult = await cloudantService.postFind({
                db: 'patients',
                selector: { patient_id: patientID }
            });
            if (findResult && findResult.result && findResult.result.docs && findResult.result.docs.length > 0) {
                var patient = findResult.result.docs[0];
                var returnCode = 0;
                if (findResult.result.docs.length === 0) {
                    returnCode = 1;
                }
                var resData = {"HCCMAREA": {
                    "CA_REQUEST_ID": "01IPAT",
                    "CA_RETURN_CODE": returnCode,
                    "CA_PATIENT_ID": patient.patient_id,
                    "CA_PATIENT_REQUEST": {
                        "CA_ADDRESS": patient.address,
                        "CA_CITY": patient.city,
                        "CA_DOB": patient.birthdate,
                        "CA_FIRST_NAME": patient.first_name,
                        "CA_GENDER": patient.gender,
                        "CA_LAST_NAME": patient.last_name,
                        "CA_POSTCODE": patient.postcode,
                        "CA_USERID": patient.user_id,
                        "PATIENTID": patient.patient_id
                    }
                }};
                res.json(resData);
            } else {
                console.error(findResult);
                res.status(404).send({ error: `Patient with ID ${patientID} not found` });
            }
        } catch (err) {
            console.error(err);
            res.status(500).send({ error: `Error getting patient data for ${patientID}` });
        }
    } else {
        res.status(500).send({ error: "Cloudant not initialized." });
    }
});

app.get('/api/getInfo/prescription/:id', async function(req, res) {
    var patientID = req.params.id;

    if (cloudantService) {
        try {
            const findResult = await cloudantService.postFind({
                db: 'prescriptions',
                selector: { patient_id: patientID }
            });
            if (findResult && findResult.result && findResult.result.docs && findResult.result.docs.length > 0) {
                var prescriptions = findResult.result.docs;
                var prescriptionStr = JSON.stringify(prescriptions);
                prescriptionStr = prescriptionStr.replace(/drug_name/g, "CA_DRUG_NAME");
                prescriptionStr = prescriptionStr.replace(/patient_id/g, "PATIENT");
                prescriptionStr = prescriptionStr.replace(/medication_id/g, "CA_MEDICATION_ID");
                prescriptionStr = prescriptionStr.replace(/reason/g, "REASONDESCRIPTION");
                prescriptions = JSON.parse(prescriptionStr);
                for (var i = 0; i < prescriptions.length; i++) {
                    delete prescriptions[i]._id;
                    delete prescriptions[i]._rev;
                }
                var returnCode = 0;
                if (findResult.result.docs.length === 0) {
                    returnCode = 1;
                }
                var resData = {"GETMEDO": {
                    "CA_REQUEST_ID": "01IPAT",
                    "CA_RETURN_CODE": returnCode,
                    "CA_PATIENT_ID": patientID,
                    "CA_LIST_MEDICATION_REQUEST": {
                        "CA_MEDICATIONS": prescriptions
                    }
                }};
                res.json(resData);
            } else {
                console.error(findResult);
                res.status(404).send({ error: `Prescription data not found for ${patientID}` });
            }
        } catch (err) {
            console.error(err);
            res.status(500).send({ error: `Error getting prescription data for ${patientID}` });
        }
    } else {
        res.status(500).send({ error: "Cloudant not initialized." });
    }
});

app.get('/api/appointments/list/:id', async function(req,res) {
    var patient = req.params.id;

    if (cloudantService) {
        try {
            const findResult = await cloudantService.postFind({
                db: 'appointments',
                selector: { patient_id: patient }
            });
            if (findResult && findResult.result && findResult.result.docs && findResult.result.docs.length > 0) {
                var appointments = findResult.result.docs;
                var appointmentsData = [];
                for (const appointment of appointments) {
                    appointmentsData.push({
                        "APPT_DATE": appointment.date,
                        "APPT_TIME": appointment.time,
                        "MED_FIELD": "GENERAL PRACTICE",
                    });
                }
                var resData = {"ResultSet Output": appointmentsData};
                res.json(resData);
            } else {
                console.error(findResult);
                res.status(404).send({ error: `Appointments not found for patient "${patient}"` });
            }
        } catch (err) {
            console.error(err);
            res.status(500).send({ error: `Error getting appointments for patient "${patient}"` });
        }
    } else {
        res.status(500).send({ error: "Cloudant not initialized." });
    }
});

app.get('/api/listObs/:id', async function(req, res) {
    var patient = req.params.id;

    if (cloudantService) {
        try {
            const findResult = await cloudantService.postFind({
                db: 'observations',
                selector: { patient_id: patient }
            });
            if (findResult && findResult.result && findResult.result.docs && findResult.result.docs.length > 0) {
                var observations = findResult.result.docs;
                var observationsData = [];
                for (const observation of observations) {
                    var toPush = {
                        "CODE": observation.code,
                        "DATEOFOBSERVATION": observation.date,
                        "DESCRIPTION": observation.description,
                        "PATIENT": patient,
                        "UNITS": observation.units,
                        "id": observation.id
                    };
                    if (observation.numeric_value !== "") {
                        toPush["NUMERICVALUE"] = observation.numeric_value;
                    }
                    if (observation.character_value !== "") {
                        toPush["CHARACTERVALUE"] = observation.character_value;
                    }
                    observationsData.push(toPush);
                }
                var resData = {"ResultSet Output": observationsData};
                res.json(resData);
            } else {
                console.error(findResult);
                res.status(404).send({ error: `Observations not found for patient "${patient}"` });
            }
        } catch (err) {
            console.error(err);
            res.status(500).send({ error: `Error getting observations for patient "${patient}"` });
        }
    } else {
        res.status(500).send({ error: "Cloudant not initialized." });
    }
});