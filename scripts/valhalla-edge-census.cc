// Source-only graph census. No actor, route, trace or matcher APIs.
#include <valhalla/baldr/graphreader.h>
#include <boost/property_tree/json_parser.hpp>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <cstdint>
#include <iomanip>
#include <stdexcept>
#include <vector>
using namespace valhalla::baldr;
int main(int argc,char** argv) {
  try {
    if(argc!=3) throw std::runtime_error("config and fresh output path required");
    boost::property_tree::ptree config;boost::property_tree::read_json(argv[1],config);
    GraphReader reader(config.get_child("mjolnir"));
    auto tile_set=reader.GetTileSet();std::vector<GraphId> tiles(tile_set.begin(),tile_set.end());
    std::sort(tiles.begin(),tiles.end(),[](auto a,auto b){return a.value<b.value;});
    if(tiles.empty()||tiles.size()>8192) throw std::runtime_error("tile count limit");
    std::ifstream existing(argv[2]);if(existing.good())throw std::runtime_error("output already exists");
    std::ofstream out(argv[2]);out.exceptions(std::ios::badbit|std::ios::failbit);out<<std::setprecision(15);
    uint64_t total_nodes=0,total_edges=0;
    auto end_record=[&](){out<<'\n';if(out.tellp()>32*1024*1024)throw std::runtime_error("census output exceeds limit_bytes=33554432");};
    for(auto tile_id:tiles){
      auto tile=reader.GetGraphTile(tile_id);if(!tile)throw std::runtime_error("enumerated tile missing");
      auto h=tile->header();auto nc=h->nodecount(),ec=h->directededgecount();
      if(total_nodes+nc>500000||total_edges+ec>1000000)throw std::runtime_error("graph cardinality limit");
      out<<"{\"kind\":\"tile\",\"tile\":"<<tile_id.value<<",\"level\":"<<tile_id.level()<<",\"nodes\":"<<nc<<",\"edges\":"<<ec<<"}";end_record();
      std::vector<uint32_t> starts(ec,UINT32_MAX);
      for(uint32_t ni=0;ni<nc;++ni){
        auto node=tile->node(ni);GraphId nid(tile_id.tileid(),tile_id.level(),ni);auto ll=tile->get_node_ll(nid);
        if(!std::isfinite(ll.lat())||!std::isfinite(ll.lng()))throw std::runtime_error("invalid node geometry");
        out<<"{\"kind\":\"node\",\"tile\":"<<tile_id.value<<",\"index\":"<<ni<<",\"id\":"<<nid.value<<",\"access\":"<<node->access()<<",\"type\":"<<static_cast<int>(node->type())<<",\"coordinate\":["<<ll.lat()<<','<<ll.lng()<<"],\"edgeIndex\":"<<node->edge_index()<<",\"edgeCount\":"<<node->edge_count()<<",\"transitions\":[";
        for(uint32_t j=0;j<node->transition_count();++j){auto t=tile->transition(node->transition_index()+j);if(j)out<<',';out<<"{\"endNode\":"<<t->endnode().value<<",\"up\":"<<(t->up()?"true":"false")<<"}";}
        out<<"]}";end_record();
        for(uint32_t j=0;j<node->edge_count();++j){uint64_t ei=uint64_t(node->edge_index())+j;if(ei>=ec||starts[ei]!=UINT32_MAX)throw std::runtime_error("node edge range invalid/overlapping");starts[ei]=ni;}
      }
      for(uint32_t ei=0;ei<ec;++ei){
        if(starts[ei]==UINT32_MAX)throw std::runtime_error("directed edge lacks start node");
        auto edge=tile->directededge(ei);GraphId eid(tile_id.tileid(),tile_id.level(),ei),start(tile_id.tileid(),tile_id.level(),starts[ei]);
        auto info=tile->edgeinfo(edge);auto shape=info.shape();if(!edge->forward())std::reverse(shape.begin(),shape.end());
        if(shape.size()<2||shape.size()>100000)throw std::runtime_error("edge shape cardinality invalid");
        bool end_exists=reader.DoesTileExist(edge->endnode().tile_base());GraphId opposing;
        if(end_exists){auto end_tile=reader.GetGraphTile(edge->endnode());if(!end_tile||edge->endnode().id()>=end_tile->header()->nodecount())throw std::runtime_error("end node outside tile");opposing=reader.GetOpposingEdgeId(eid);}
        out<<"{\"kind\":\"edge\",\"tile\":"<<tile_id.value<<",\"index\":"<<ei<<",\"id\":"<<eid.value<<",\"startNode\":"<<start.value<<",\"endNode\":"<<edge->endnode().value<<",\"endTilePresent\":"<<(end_exists?"true":"false")<<",\"opposingEdge\":";
        if(opposing.is_valid())out<<opposing.value;else out<<"null";
        out<<",\"wayId\":"<<info.wayid()<<",\"forwardAccess\":"<<edge->forwardaccess()<<",\"reverseAccess\":"<<edge->reverseaccess()<<",\"use\":"<<static_cast<int>(edge->use())<<",\"roadClass\":"<<static_cast<int>(edge->classification())<<",\"shortcut\":"<<(edge->is_shortcut()?"true":"false")<<",\"forward\":"<<(edge->forward()?"true":"false")<<",\"lengthMeters\":"<<edge->length()<<",\"restrictions\":"<<edge->restrictions()<<",\"accessRestrictionMask\":"<<edge->access_restriction()<<",\"startRestrictionMask\":"<<edge->start_restriction()<<",\"endRestrictionMask\":"<<edge->end_restriction()<<",\"complexRestriction\":"<<(edge->part_of_complex_restriction()?"true":"false")<<",\"accessRestrictions\":[";
        bool first=true;for(const auto& ar:tile->GetAccessRestrictions(ei)){if(!first)out<<',';first=false;out<<"{\"type\":"<<static_cast<int>(ar.type())<<",\"modes\":"<<ar.modes()<<",\"value\":"<<ar.value()<<",\"exceptDestination\":"<<(ar.except_destination()?"true":"false")<<"}";}
        out<<"],\"shape\":[";first=true;for(const auto& p:shape){if(!std::isfinite(p.lat())||!std::isfinite(p.lng())||std::abs(p.lat())>90||std::abs(p.lng())>180)throw std::runtime_error("invalid edge geometry");if(!first)out<<',';first=false;out<<'['<<p.lat()<<','<<p.lng()<<']';}out<<"]}";end_record();
      }
      total_nodes+=nc;total_edges+=ec;reader.Clear();
    }
    out<<"{\"kind\":\"complete\",\"tiles\":"<<tiles.size()<<",\"nodes\":"<<total_nodes<<",\"edges\":"<<total_edges<<"}";end_record();
  }catch(const std::exception& e){std::cerr<<"Census failed: "<<e.what()<<'\n';return 1;}
}
