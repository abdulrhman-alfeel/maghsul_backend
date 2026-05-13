import  { Storage } from "@google-cloud/storage";
const storage = new Storage({
  keyFilename: "maghsul-dbf163939c57.json",
});
// const bucketName = "demo_backendmoshrif-1";
const bucketName = "maghsul_storge";

const bucket = storage.bucket(bucketName);
async function uploaddata(file) {
  // const blob = bucket.file(file.filename);
  try {
    console.log( 'path', file.path);
    console.log( 'name', file.name);
    await bucket.upload(file.path);
  } catch (error) {
    console.log(error);
  }

}

async function uploadFile(outputPrefix, filePath) {
  try {
    await bucket.upload(filePath, {
      destination: outputPrefix,
    });

    // console.log("✅ File uploaded successfully");
  } catch (err) {
    console.error("❌ Upload failed:", err);
  }
}


   
async function DeleteBucket (nameOld){
  try {
    const file = bucket.file(nameOld);
    await file
    .delete()
    .then(() => {
      // console.log(`File ${nameOld} deleted from bucket`);
    })
    .catch((err) => {
      // console.log(`Error deleting file: ${err}`);
    });  } catch (error) {
    console.log(error);
  }
}
async function RenameBucket (nameOld,name){
  try {
    const file = bucket.file(nameOld);
    await file
    .rename(name)
    .then(() => {
      // console.log(`File renamed to ${name}`);
    })
    .catch((err) => {
      console.error(`Error renaming file: ${err}`);
    });  } catch (error) {
    console.log(error);
  }
}

async function checkIfFileExists(fileName) {
  return new Promise(async (resolve, reject) => {
    const file = bucket.file(fileName);

    try {
      // Check if the file exists
      const [exists] = await file.exists();
      resolve(exists);
     
    } catch (error) {
      console.log("Error checking file existence:", error);
    }
  });
};

export { uploaddata, bucket, uploadFile, checkIfFileExists, DeleteBucket, RenameBucket };
