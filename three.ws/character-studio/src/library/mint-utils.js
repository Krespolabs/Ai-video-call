import { ethers } from "ethers"
import { getVRMBlobData } from "./download-utils"
import { CharacterContract, EternalProxyContract, webaverseGenesisAddress } from "../components/Contract"
import { SolanaManager } from "./solanaManager"
import { Connection, Transaction } from "@solana/web3.js";
// import { Connection, PublicKey } from '@solana/web3.js';
// import { Metaplex } from '@metaplex-foundation/js';

const rpcKey = import.meta.env.VITE_HELIUS_KEY;
const rpcUrl = `https://devnet.helius-rpc.com/?api-key=${rpcKey}`

const opensea_Key = import.meta.env.VITE_OPENSEA_KEY;
const validation_server = import.meta.env.VITE_VALIDATION_SERVER_URL;

// IPFS pinning is performed SERVER-SIDE via three.ws's /api/pinning/pin endpoint
// (authenticated with the caller's session, secret held only on the server). The
// Pinata API secret is NEVER exposed to the browser bundle — embedding
// VITE_PINATA_API_SECRET here shipped a billing-capable credential to every
// visitor of /avatar-studio.
const PIN_ENDPOINT = '/api/pinning/pin'

//const mintCost = 0.01
let tokenPrice;

const manager = new SolanaManager();
console.log(manager);

// setTimeout(() => {
//   console.log("t")
//   getContract("0xFF9C1b15B16263C61d017ee9F65C50e4AE0113D7");
// }, 5000);



async function getTokenPrice(){
  if (tokenPrice != null)
    return tokenPrice
  const defaultProvider = new ethers.JsonRpcProvider('https://polygon-rpc.com/')
  const contract = new ethers.Contract(CharacterContract.address, CharacterContract.abi, defaultProvider)
  const tp = await contract.tokenPrice()
  tokenPrice = BigInt(tp);
  return tokenPrice
}


export function ownsCollection (wallet, network, collection){
  return new Promise((resolve, reject) => {
    fetchOwnedNFTs(wallet, network, collection).then(response=>{
      resolve (response?.nfts?.length > 0);
    }).catch(err=>{
      reject(err);
    })
  });
}

export function fetchSolanaPurchasedAssets(walletAddress, delegateAddress, collectionName){
  return new Promise((resolve, reject) => {
    manager.getUserCNFTs(walletAddress,delegateAddress,collectionName)
      .then(response=>{
        resolve(response)
      }).catch(err => {
        // Reject the Promise with the error encountered during the fetch
        reject(err);
      });
  });
}

export function buySolanaPurchasableAssets(merchantPublicKey, treeAddress, collectionName, amount, purchaseNFTs){
  
  return new Promise((resolve, reject) => {
    (async () => {
    const { solana } = window;
    console.log(window.solana)

    if (!solana || !solana.isPhantom) {
        alert("Please install Phantom Wallet!");
        reject();
    }
    if (!validation_server) {
      alert("VITE_VALIDATION_SERVER_URL not defined in .env");
      reject();
    }
    try{
      const solanaAddress = await window.solana.connect();
      const buyerPublicKey = solanaAddress.publicKey.toString();
      const response = await fetch(`${validation_server}/request-payment`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
            body: JSON.stringify({ buyerPublicKey, merchantPublicKey, treeAddress, collectionName, purchaseNFTs, amount })
      });

      const data = await response.json();
      if (data.transaction) {
        const transaction = data.transaction;
        const signature = await signAndSendTransaction(transaction);
        if (signature == null){
          reject();
        }
        else{
          resolve();
        }
      } else {
        console.error("Error requesting payment:", data.error);
        reject();
      }
    }
    catch(e){
      //console.log(data);
      console.error("Error requesting payment:", e.message);
      reject();
    }
    })().catch(reject);

  });
}

async function signAndSendTransaction(base64Transaction) {
  const { solana } = window;
  if (!solana || !solana.isPhantom) {
      alert("Please install Phantom Wallet!");
      return;
  }

  let connection;
  try {
      connection = new Connection(rpcUrl);

      // Decode Base64 transaction to Uint8Array
      const transactionBytes = Uint8Array.from(atob(base64Transaction), (c) => c.charCodeAt(0));
      const decodedTransaction = Transaction.from(transactionBytes);

      // Request wallet to sign the transaction
      const signedTransaction = await solana.signTransaction(decodedTransaction);
      
      // Send the signed transaction to Solana network
      const signature = await connection.sendRawTransaction(signedTransaction.serialize({ requireAllSignatures: false }));

      console.log("✅ Transaction Signature:", signature);
      return signature;
  } catch (error) {
      console.error("❌ Transaction failed:", error);
      if (error.logs) {
          console.error("🔍 Transaction logs:", error.logs);
      } else if (error.signature) {
          // Manually fetch logs from the blockchain
          console.log("Fetching logs for signature:", error.signature);
          const logs = await connection.getTransaction(error.signature, { commitment: "confirmed" });
          console.error("🔍 Transaction logs:", logs?.meta?.logMessages);
      }
  }
}

/**
 * Fetches Opensea collection data for a specific Ethereum account and collection.
 *
 * @param {string} address - The Ethereum account address.
 * @param {string} collection - The name or identifier of the Opensea collection.
 * @returns {Promise} A Promise that resolves with the JSON response from the Opensea API.
 */


export function fetchOwnedNFTs (walletAddress, network, collection){
  switch (network.toLowerCase()) {
    case 'ethereum':{
      return fetchFromOpensea(walletAddress, "ethereum", collection);
    }
    case 'polygon':{
      return fetchFromOpensea(walletAddress, "matic", collection);
    }
    case 'solana':{
      console.warn("solana work in progress");
      return Promise.resolve(false);
    }
    default:{
      console.log("Unsupported Netwrok: " + walletAddress)
      return Promise.resolve(false);
    }
  }
}


const fetchFromOpensea = (walletAddress, chain, collection) => {
  if (opensea_Key == null){
    console.error("No opensea key was provided. Cant fetch user's owned nft's");
    return;
  }
  const options = {
    method: 'GET',
    headers: { accept: 'application/json', 'x-api-key': opensea_Key },
  };
  // Returning a Promise
  return new Promise((resolve, reject) => {
    fetch('https://api.opensea.io/api/v2/chain/' + chain + '/account/' + walletAddress + '/nfts?limit=200&collection=' + collection, options)
      .then(response => {
        // Check if the response status is ok (2xx range)
        if (response.ok) {
          
          return response.json();
        } else {
          // If the response status is not ok, reject the Promise with an error message
          reject('Failed to fetch data from Opensea API');
        }
      })
      .then(response => {
        // Resolve the Promise with the JSON response
        console.log(response)
        resolve(response);
      })
      .catch(err => {
        // Reject the Promise with the error encountered during the fetch
        reject(err);
      });
  });
}


/**
 * Switches the active wallet to a specific blockchain and retrieves the wallet address.
 * 
 * @param {string} network - The blockchain name (`"ethereum"`, `"polygon"` or `"solana"`).
 * @param {string} wallet - The wallet name (`"metamask"`, `"phantom"` or `"solana"`).
 * @returns {Promise<string>} A promise resolving to the active wallet address, or an empty string on error.
 */
export function connectWallet(network) {
  console.log("connect wallet:", network);
  return new Promise((resolve, reject) => {
    (async () => {
    try {
      switch (network.toLowerCase()) {
        case 'ethereum':
        case 'polygon': {
          if (!window.ethereum) {
            return reject(new Error('Ethereum wallet is not available.'));
          }

          const chainIdMap = {
            ethereum: '0x1', // Ethereum Mainnet
            polygon: '0x89', // Polygon Mainnet
          };
          const targetChain = network.toLowerCase() === 'ethereum' ? chainIdMap.ethereum : chainIdMap.polygon;

          await window.ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: targetChain }],
          })

          const accounts = await window.ethereum.request({
            method: 'eth_requestAccounts',
          });

          return resolve(accounts.length > 0 ? accounts[0] : '');
        }

        case 'solana': {
          if (!window.solana || !window.solana.isPhantom) {
            return reject(new Error('Solana wallet (Phantom) is not available.'));
          }
          const response = await window.solana.connect();
          return resolve(response.publicKey.toString());
        }

        default:
          return reject(new Error('Unsupported network.'));
      }
    } catch (error) {
      return reject(error);
    }
    })().catch(reject);
  });
}



// ready to test
// export async function connectWallet(){
//   if (window.ethereum) {
//     try {
//       const chain = await window.ethereum.request({ method: 'eth_chainId' })
      
//       if (parseInt(chain, 16) == parseInt(chainId, 16)) {
//         const addressArray = await window.ethereum.request({
//           method: 'eth_requestAccounts',
//         })
//         return addressArray.length > 0 ? addressArray[0] : ""
//       } else {
//           try {
//             await window.ethereum.request({
//               method: 'wallet_switchEthereumChain',
//               params: [{ chainId: chainId }],
//             })
//             const addressArray = await window.ethereum.request({
//               method: 'eth_requestAccounts',
//             })
//             return addressArray.length > 0 ? addressArray[0] : ""
//           } catch (err) {
//             console.log("polygon not find:", err)
//             // Add Polygon chain to the metamask.
//             try {
//               await window.ethereum.request({
//                 method: 'wallet_addEthereumChain',
//                 params: [
//                   {   
//                     chainId: '0x89',
//                     chainName: 'Polygon Mainnet',
//                     rpcUrls: ['https://polygon-rpc.com'],
//                     nativeCurrency: {
//                         name: "Matic",
//                         symbol: "MATIC",
//                         decimals: 18
//                     },
//                     blockExplorerUrls: ['https://polygonscan.com/']                      },
//                 ]
//               });
//             await window.ethereum.request({
//               method: 'wallet_switchEthereumChain',
//               params: [{ chainId: chainId }],
//             })
//             const addressArray = await window.ethereum.request({
//               method: 'eth_requestAccounts',
//             })
//           return addressArray.length > 0 ? addressArray[0] : ""
//             } catch (error) {
//               console.log("Adding polygon chain failed", error);
//             }
//           }
//       }
//     } catch (err) {
//       return "";
//     }
//   } else {
//     return "";
//   }
// }

// Read a Blob/File as a base64 data: URL so it can be handed to the server pin
// endpoint (which accepts a data: URL and pins the bytes with the server-held key).
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(reader.error || new Error("failed to read file"))
        reader.readAsDataURL(blob)
    })
}

// Pin a file to IPFS via the three.ws server proxy. `kind` is 'glb' for the model
// and 'manifest' for images/JSON metadata. Returns { IpfsHash } so existing
// callers are unchanged. No Pinata credentials touch the browser.
async function saveFileToPinata(fileData, fileName, kind = "manifest") {
    if (!fileData) {
        console.warn("Error saving to pinata: No file data")
        return
    }
    const blob = fileData instanceof Blob ? fileData : new Blob([fileData])
    const dataUrl = await blobToDataUrl(blob)
    const resp = await fetch(PIN_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: dataUrl, kind, filename: fileName }),
    })
    if (!resp.ok) {
        const detail = await resp.text().catch(() => "")
        throw new Error(`pin failed (${resp.status}): ${detail}`)
    }
    const out = await resp.json()
    // Normalize to the Pinata-style shape callers already expect.
    return { IpfsHash: out.cid || out.IpfsHash, ...out }
}

const getAvatarTraits = (avatar) => {
  let metadataTraits = []
  Object.keys(avatar).map((trait) => {
    if (Object.keys(avatar[trait]).length !== 0) {
      metadataTraits.push({
        trait_type: trait,
        value: avatar[trait].name,
      })
    }
  })
  return metadataTraits
}

export async function mintAsset(avatar, screenshot, model, name, needCheckOT){
    if (!avatar)
        throw new Error("No avatar was provided")
    if (!screenshot)
        throw new Error("No screenshot was provided")
    if (!model)
        throw new Error("No model was provided")

    const walletAddress = await connectWallet();
    if (walletAddress == "")
      return ("Please Connect Wallet")

    const pass = !needCheckOT || await checkOT(walletAddress);
    if (pass){
        console.log("minting")
        // set image
        let imageName = "AvatarImage_" + Date.now() + ".png";
        let imageHash = await (async() => {
          for (let i = 0; i < 10; i++) { // hack: give it a few tries, sometimes uploading to pinata fail for some reason
            try {
              const img_hash = await saveFileToPinata(
                screenshot,
                imageName,
                "manifest"
              ).catch((reason) => {
                console.error(i, "---", reason)
              })
              return img_hash
            } catch(err) {
              console.warn(err);
              return err;
            }
          }
          return 'Failed to upload screenshot';
          //throw new Error('failed to upload screenshot');
        })()
        const glb = await getVRMBlobData(model,avatar,4096,true)
        let glbHash;
        if (glb) {
            let glbName = "AvatarGlb_" + Date.now() + ".glb";
            glbHash = await (async() => {
            for (let i = 0; i < 10; i++) { // hack: give it a few tries, sometimes uploading to pinata fail for some reason
                try {
                const glb_hash = await saveFileToPinata(
                    glb,
                    glbName,
                    "glb"
                ).catch((reason) => {
                    console.error(i, "---", reason)
                    return "Couldn't save glb to pinata"
                    //setMintStatus("Couldn't save glb to pinata")
                })
                return glb_hash
                } catch(err) {
                  console.warn(err);
                  return "Couldn't save glb to pinata"
                }
            }
            return 'Failed to upload glb'
            //throw new Error('failed to upload glb');
            })();
        } else {
          return 'Unable to get glb'
        }
        const metadata = {
            name: name || "Avatars",
            description: "three.ws Avatars.",
            image: `ipfs://${imageHash.IpfsHash}`,
            animation_url: `ipfs://${glbHash.IpfsHash}`,
            attributes: getAvatarTraits(avatar)
        }
        const str = JSON.stringify(metadata)
        const metaDataHash = await saveFileToPinata(
            new Blob([str]),
            "AvatarMetadata_" + Date.now() + ".json",
            "manifest"
        )
        const metadataIpfs = `ipfs://${metaDataHash.IpfsHash}`

        let price = await getTokenPrice()

        const signer = await new ethers.BrowserProvider(window.ethereum).getSigner()
        const contract = new ethers.Contract(CharacterContract.address, CharacterContract.abi, signer)
        try {
          const options = {
            value: price,
            from: walletAddress
          }
          const tx = await contract.mintToken(1, metadataIpfs, options)
          let res = await tx.wait()
          if (res.transactionHash) {
            console.log("Mint success!")
            return "Mint success!";
          }
        } catch {
          //console.log("Public Mint failed! Please check your wallet.")
          return "Public Mint failed."
        }

    }
}

const checkOT = async (address) => {
    if(address) {
      const address = '0x6e58309CD851A5B124E3A56768a42d12f3B6D104'
      const ethersigner = ethers.getDefaultProvider("mainnet", {
        alchemy: import.meta.env.VITE_ALCHEMY_API_KEY,
      })
      const contract = new ethers.Contract(EternalProxyContract.address, EternalProxyContract.abi, ethersigner);
      const webaBalance = await contract.beneficiaryBalanceOf(address, webaverseGenesisAddress, 1);
      if(parseInt(webaBalance) > 0) return true;
      else {
        console.log("Currently in alpha. You need a genesis pass to mint. \n Will be public soon!")
        return false;
      }
    } else {
      console.log("Please connect your wallet")
      return false;
    }
}

// const showTrait = (trait) => {
//     if (trait.name in avatar) {
//         if ("traitInfo" in avatar[trait.name]) {
//         return avatar[trait.name].name
//         } else return "Default " + trait.name
//     } else return "No set"
// }