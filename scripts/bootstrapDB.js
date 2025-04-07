const path = require('path');
const fs = require('fs');
const { parse } = require('csv');

async function importCSVData(cloudantService, database, filePath) {
    const documents = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(parse({
                delimiter: ',',
                columns: true,
                skip_empty_lines: true
            }))
            .on('data', (row) => {
                documents.push(row);
            })
            .on('end', async () => {
                try {
                    const result = await cloudantService.postBulkDocs({ db: database, bulkDocs: { docs: documents } });
                    console.log(`  -> Successfully imported ${documents.length} documents into "${database}".`);
                    resolve(result);
                } catch (err) {
                    console.error(`  -> Error during bulk insert into "${database}" from "${filePath}":`, err);
                    reject(err);
                }
            })
            .on('error', (error) => {
                console.error(`  -> Error reading or parsing CSV file "${filePath}":`, error);
                reject(error);
            });
    });
}

module.exports = async function (connectionURL, cloudantService) {
    const dataFolderPath = path.join(__dirname, '..', 'patient_data');
    const databasesAndFiles = {
        'allergies': 'allergies.csv',
        'appointments': 'appointments.csv',
        'observations': 'observations.csv',
        'organizations': 'organizations.csv',
        'patients': 'patients.csv',
        'prescriptions': 'prescriptions.csv',
        'providers': 'providers.csv',
    };

    try {
        for (const database in databasesAndFiles) {
            const filePath = path.join(dataFolderPath, databasesAndFiles[database]);
            console.log(`Processing database: ${database} from file: ${filePath}`);
            try {
                await cloudantService.putDatabase({ db: database }).catch(err => {
                    if (err.statusCode !== 412) { // 412 means database already exists
                        console.log(`  -> Error creating database "${database}":`, err.message);
                        throw err; // Re-throw the error to be caught by the outer try-catch
                    } else {
                        console.log(`  -> Database "${database}" already exists.`);
                    }
                });
                await importCSVData(cloudantService, database, filePath);
            } catch (error) {
                console.error(`Error processing ${database}:`, error);
            }
        }
        return "Done importing data.";
    } catch (err) {
        return (err);
    }
};